// src/indexer/extractor.ts
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Parser from "web-tree-sitter";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LanguageMapping {
  function: string[];
  class: string[];
  import: string[];
  call: string[];
  name_field: string;
  body_field: string;
  parameters_field: string;
}

type LanguageMap = Record<string, LanguageMapping>;

const languageMap: LanguageMap = JSON.parse(
  readFileSync(join(__dirname, "language-map.json"), "utf-8")
);

export interface ExtractedFunction {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string | null;
  snippet: string;
  className: string | null;
}

export interface ExtractedClass {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  docstring: string | null;
}

export interface ExtractedImport {
  source: string;
  specifiers: string[];
  isDefault: boolean;
}

export interface ExtractedCall {
  callerName: string;
  callerFilePath: string;
  calleeName: string;
}

export interface GraphEntities {
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function getDocstring(
  node: Parser.SyntaxNode,
  source: string
): string | null {
  const prev = node.previousNamedSibling;
  if (prev && prev.type === "comment") {
    return getNodeText(prev, source).replace(/^\/\*\*?|\*\/$/g, "").trim();
  }
  // Python docstrings: first child of body is expression_statement > string
  const body = node.childForFieldName("body");
  if (body) {
    const first = body.firstNamedChild;
    if (first?.type === "expression_statement") {
      const str = first.firstNamedChild;
      if (str?.type === "string") {
        return getNodeText(str, source)
          .replace(/^['"]|['"]$/g, "")
          .replace(/^"""|"""$/g, "")
          .trim();
      }
    }
  }
  return null;
}

function extractSignature(
  node: Parser.SyntaxNode,
  source: string
): string {
  const lines = getNodeText(node, source).split("\n");
  return lines[0].trim();
}

function walkForCalls(
  node: Parser.SyntaxNode,
  source: string,
  callerName: string,
  callerFilePath: string,
  callTypes: string[]
): ExtractedCall[] {
  const calls: ExtractedCall[] = [];

  function walk(n: Parser.SyntaxNode): void {
    if (callTypes.includes(n.type)) {
      const fnNode = n.childForFieldName("function") || n.firstNamedChild;
      if (fnNode) {
        let calleeName: string;
        if (fnNode.type === "member_expression" || fnNode.type === "attribute") {
          const prop =
            fnNode.childForFieldName("property") ||
            fnNode.childForFieldName("attribute");
          calleeName = prop
            ? getNodeText(prop, source)
            : getNodeText(fnNode, source);
        } else if (
          fnNode.type === "identifier" ||
          fnNode.type === "property_identifier"
        ) {
          calleeName = getNodeText(fnNode, source);
        } else {
          calleeName = getNodeText(fnNode, source);
        }
        if (calleeName && calleeName !== callerName) {
          calls.push({ callerName, callerFilePath, calleeName });
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }

  walk(node);
  return calls;
}

export function extractGraphEntities(
  tree: Parser.Tree,
  language: string,
  source: string,
  filePath: string
): GraphEntities {
  const absPath = resolve(filePath);
  const mapping = languageMap[language];

  const functions: ExtractedFunction[] = [];
  const classes: ExtractedClass[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];

  if (!mapping) {
    return { functions, classes, imports, calls };
  }

  const functionTypes = new Set(mapping.function);
  const classTypes = new Set(mapping.class);
  const importTypes = new Set(mapping.import);

  function walkNode(
    node: Parser.SyntaxNode,
    currentClassName: string | null
  ): void {
    if (classTypes.has(node.type)) {
      const nameNode = node.childForFieldName(mapping.name_field);
      if (nameNode) {
        const className = getNodeText(nameNode, source);
        classes.push({
          name: className,
          filePath: absPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          docstring: getDocstring(node, source),
        });
        for (let i = 0; i < node.childCount; i++) {
          walkNode(node.child(i)!, className);
        }
        return;
      }
    }

    if (functionTypes.has(node.type)) {
      const nameNode = node.childForFieldName(mapping.name_field);
      if (nameNode) {
        const funcName = getNodeText(nameNode, source);
        const snippet = getNodeText(node, source);
        const signature = extractSignature(node, source);

        functions.push({
          name: funcName,
          filePath: absPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature,
          docstring: getDocstring(node, source),
          snippet,
          className: currentClassName,
        });

        const funcCalls = walkForCalls(
          node,
          source,
          funcName,
          absPath,
          mapping.call
        );
        calls.push(...funcCalls);
        return;
      }
    }

    if (importTypes.has(node.type)) {
      const text = getNodeText(node, source);
      const sourceNode =
        node.childForFieldName("source") ||
        node.childForFieldName("module_name") ||
        node.childForFieldName("path");
      const importSource = sourceNode
        ? getNodeText(sourceNode, source).replace(/['"]/g, "")
        : text;

      imports.push({
        source: importSource,
        specifiers: [],
        isDefault: text.includes("import default") || !text.includes("{"),
      });
    }

    for (let i = 0; i < node.childCount; i++) {
      walkNode(node.child(i)!, currentClassName);
    }
  }

  walkNode(tree.rootNode, null);

  return { functions, classes, imports, calls };
}
