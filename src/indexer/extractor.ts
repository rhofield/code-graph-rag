// src/indexer/extractor.ts
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Parser from "web-tree-sitter";
import {
  extractGraphQLArtifactsFromTypeScript,
  extractGraphQLUsagesFromFunction,
  parseGraphQLDocuments,
  type ExtractedGraphQLDocument,
  type ExtractedGraphQLFragmentSpread,
  type ExtractedGraphQLUsage,
} from "./graphql-detector.js";

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
  graphqlDocuments: ExtractedGraphQLDocument[];
  graphqlUsages: ExtractedGraphQLUsage[];
  graphqlFragmentSpreads: ExtractedGraphQLFragmentSpread[];
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function cleanPropertyName(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function getPairKey(node: Parser.SyntaxNode, source: string): string | null {
  if (node.type !== "pair") return null;
  const keyNode = node.childForFieldName("key");
  return keyNode ? cleanPropertyName(getNodeText(keyNode, source)) : null;
}

function isGraphQLRootResolverPair(node: Parser.SyntaxNode, source: string): boolean {
  const parentObject = node.parent;
  const parentPair = parentObject?.parent;
  if (parentObject?.type !== "object" || parentPair?.type !== "pair") return false;

  const rootTypeName = getPairKey(parentPair, source);
  if (!rootTypeName || !["Query", "Mutation", "Subscription"].includes(rootTypeName)) return false;

  for (let current: Parser.SyntaxNode | null = parentPair; current; current = current.parent) {
    if (current.type === "pair" && /^resolvers?$/i.test(getPairKey(current, source) ?? "")) {
      return true;
    }

    if (current.type === "variable_declarator") {
      const nameNode = current.childForFieldName("name");
      const name = nameNode ? getNodeText(nameNode, source) : "";
      if (/resolvers?/i.test(name)) return true;
    }
  }

  return false;
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
  let graphqlDocuments: ExtractedGraphQLDocument[] = [];
  let graphqlUsages: ExtractedGraphQLUsage[] = [];
  let graphqlFragmentSpreads: ExtractedGraphQLFragmentSpread[] = [];

  if (!mapping) {
    return { functions, classes, imports, calls, graphqlDocuments, graphqlUsages, graphqlFragmentSpreads };
  }

  const graphqlArtifacts =
    language === "typescript" || language === "tsx" || language === "javascript"
      ? extractGraphQLArtifactsFromTypeScript(source, absPath)
      : null;

  if (graphqlArtifacts) {
    graphqlDocuments = graphqlArtifacts.documents;
    graphqlFragmentSpreads = graphqlArtifacts.fragmentSpreads;
  } else if (language === "graphql") {
    const parsed = parseGraphQLDocuments(source, absPath);
    graphqlDocuments = parsed.documents;
    graphqlFragmentSpreads = parsed.fragmentSpreads;
  }

  const functionTypes = new Set(mapping.function);
  const classTypes = new Set(mapping.class);
  const importTypes = new Set(mapping.import);

  function walkNode(
    node: Parser.SyntaxNode,
    currentClassName: string | null
  ): void {
    if (
      (language === "typescript" || language === "tsx" || language === "javascript") &&
      node.type === "pair"
    ) {
      const keyNode = node.childForFieldName("key");
      const valueNode = node.childForFieldName("value");
      if (keyNode && valueNode) {
        const funcName = cleanPropertyName(getNodeText(keyNode, source));
        const valueText = getNodeText(valueNode, source);
        if (valueText.trimStart().startsWith("function")) {
          functions.push({
            name: funcName,
            filePath: absPath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: extractSignature(node, source),
            docstring: getDocstring(node, source),
            snippet: getNodeText(node, source),
            className: currentClassName,
          });
          calls.push(...walkForCalls(valueNode, source, funcName, absPath, mapping.call));
          return;
        }
        if (
          /^[A-Za-z_$][_0-9A-Za-z$]*$/.test(valueText.trim()) &&
          isGraphQLRootResolverPair(node, source)
        ) {
          functions.push({
            name: funcName,
            filePath: absPath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            signature: extractSignature(node, source),
            docstring: getDocstring(node, source),
            snippet: getNodeText(node, source),
            className: currentClassName,
          });
          calls.push({ callerName: funcName, callerFilePath: absPath, calleeName: valueText.trim() });
          return;
        }
      }
    }

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
      let nameNode = node.childForFieldName(mapping.name_field);

      if (!nameNode &&
        (node.type === "arrow_function" || node.type === "function_expression")
        && node.parent?.type === "variable_declarator"
      ) {
        nameNode = node.parent.childForFieldName("name");
      }

      if (!nameNode &&
        (node.type === "arrow_function" || node.type === "function_expression")
        && node.parent?.type === "pair"
      ) {
        nameNode = node.parent.childForFieldName("key");
      }

      if (nameNode) {
        const funcName = cleanPropertyName(getNodeText(nameNode, source));
        const declNode =
          node.parent?.type === "variable_declarator"
            ? (node.parent.parent ?? node)
            : node.parent?.type === "pair"
              ? node.parent
              : node;
        const snippet = getNodeText(declNode, source);
        const signature = extractSignature(declNode, source);

        functions.push({
          name: funcName,
          filePath: absPath,
          startLine: declNode.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature,
          docstring: getDocstring(declNode, source),
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
        if (graphqlArtifacts) {
          graphqlUsages.push(
            ...extractGraphQLUsagesFromFunction(
              snippet,
              funcName,
              absPath,
              graphqlArtifacts.documentVariables,
              graphqlArtifacts.documents
            )
          );
        }
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

  if (tree.rootNode) {
    walkNode(tree.rootNode, null);
  }

  return { functions, classes, imports, calls, graphqlDocuments, graphqlUsages, graphqlFragmentSpreads };
}
