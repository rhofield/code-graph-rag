import type Parser from "web-tree-sitter";
import type { ProtoRegistry, ProtoMessageDef } from "./proto-registry.js";
import {
  hasGrpcImportsGo,
  isTypeScriptProtoImportSource,
  parseNamedTypeScriptImports,
  parseNamespaceTypeScriptImports,
  parseTypeScriptImportSource,
} from "./rpc-detector.js";

// Annotates functions that produce or consume bare proto *messages* — the
// pattern used by message brokers like Google Pub/Sub, where event schemas
// are message-only protos with no service/rpc block for the RPC detector
// to key on.
export interface MessageAnnotation {
  functionName: string;
  filePath: string;
  role: "producer" | "consumer" | "uses";
  messageName: string;
  packageName: string;
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function cleanPropertyName(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pushUnique(out: MessageAnnotation[], annotation: MessageAnnotation): void {
  const exists = out.some((a) =>
    a.functionName === annotation.functionName &&
    a.filePath === annotation.filePath &&
    a.role === annotation.role &&
    a.messageName === annotation.messageName &&
    a.packageName === annotation.packageName
  );
  if (!exists) out.push(annotation);
}

// Serialize/deserialize markers decide direction: a function that encodes the
// message before handing it to a transport is a producer; one that decodes
// incoming bytes is a consumer; type-only references are neutral "uses".
const TS_SERIALIZE_RE = /\b(?:toBinary|serializeBinary|encode)\s*\(/;
const TS_DESERIALIZE_RE = /\b(?:fromBinary|deserializeBinary|decode|fromJson)\s*\(/;
const GO_SERIALIZE_RE = /\bMarshal\s*\(/;
const GO_DESERIALIZE_RE = /\bUnmarshal\s*\(/;

function rolesForFunctionText(
  text: string,
  serializeRe: RegExp,
  deserializeRe: RegExp
): Array<MessageAnnotation["role"]> {
  const roles: Array<MessageAnnotation["role"]> = [];
  if (serializeRe.test(text)) roles.push("producer");
  if (deserializeRe.test(text)) roles.push("consumer");
  if (roles.length === 0) roles.push("uses");
  return roles;
}

function annotateMessageUsage(
  functionName: string,
  bodyText: string,
  filePath: string,
  messages: ProtoMessageDef[],
  serializeRe: RegExp,
  deserializeRe: RegExp,
  out: MessageAnnotation[]
): void {
  for (const def of messages) {
    if (!new RegExp(`\\b${escapeRegExp(def.messageName)}\\b`).test(bodyText)) continue;
    for (const role of rolesForFunctionText(bodyText, serializeRe, deserializeRe)) {
      pushUnique(out, {
        functionName,
        filePath,
        role,
        messageName: def.messageName,
        packageName: def.packageName,
      });
    }
  }
}

// --- TypeScript ---

function collectTypeScriptMessageImports(
  root: Parser.SyntaxNode,
  source: string,
  registry: ProtoRegistry
): { named: ProtoMessageDef[]; namespaces: string[] } {
  const named: ProtoMessageDef[] = [];
  const namespaces: string[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type !== "import_statement") continue;

    const text = getNodeText(child, source);
    const importSource = parseTypeScriptImportSource(text);
    if (!importSource || !isTypeScriptProtoImportSource(importSource)) continue;

    namespaces.push(...parseNamespaceTypeScriptImports(text));

    for (const name of parseNamedTypeScriptImports(text)) {
      const defs = registry.lookupMessage(name);
      if (defs.length === 1) named.push(defs[0]);
    }
  }

  return { named, namespaces: [...new Set(namespaces)] };
}

function detectTypeScript(
  root: Parser.SyntaxNode,
  source: string,
  filePath: string,
  registry: ProtoRegistry,
  out: MessageAnnotation[]
): void {
  const imports = collectTypeScriptMessageImports(root, source, registry);
  if (imports.named.length === 0 && imports.namespaces.length === 0) return;

  function annotate(functionName: string, node: Parser.SyntaxNode): void {
    const text = getNodeText(node, source);
    annotateMessageUsage(functionName, text, filePath, imports.named, TS_SERIALIZE_RE, TS_DESERIALIZE_RE, out);

    for (const namespace of imports.namespaces) {
      const memberPattern = new RegExp(`\\b${escapeRegExp(namespace)}\\.([A-Za-z_$][A-Za-z0-9_$]*)\\b`, "g");
      for (const match of text.matchAll(memberPattern)) {
        const defs = registry.lookupMessage(match[1]);
        if (defs.length !== 1) continue;
        annotateMessageUsage(functionName, text, filePath, defs, TS_SERIALIZE_RE, TS_DESERIALIZE_RE, out);
      }
    }
  }

  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "pair") {
      const nameNode = node.childForFieldName("key");
      const valueNode = node.childForFieldName("value");
      if (
        nameNode &&
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
      ) {
        annotate(cleanPropertyName(getNodeText(nameNode, source)), valueNode);
        return;
      }
    }

    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (
        nameNode &&
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
      ) {
        annotate(getNodeText(nameNode, source), valueNode);
        return;
      }
    }

    if (node.type === "function_declaration" || node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        annotate(getNodeText(nameNode, source), node);
        return;
      }
    }

    // Anonymous arrow/function expressions have no stable name to annotate.
    if (node.type === "arrow_function" || node.type === "function_expression") {
      return;
    }

    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }

  walkFns(root);
}

// --- Go ---

function detectGo(
  root: Parser.SyntaxNode,
  source: string,
  filePath: string,
  registry: ProtoRegistry,
  out: MessageAnnotation[]
): void {
  if (!hasGrpcImportsGo(root, source)) return;

  // Only consider unambiguous message names; bare-name matching across
  // packages would otherwise mislink same-named events.
  const messages = registry.getAllMessages().filter(
    (m) => registry.lookupMessage(m.messageName).length === 1
  );
  if (messages.length === 0) return;

  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        annotateMessageUsage(
          getNodeText(nameNode, source),
          getNodeText(node, source),
          filePath,
          messages,
          GO_SERIALIZE_RE,
          GO_DESERIALIZE_RE,
          out
        );
      }
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }

  walkFns(root);
}

// --- Main entry point ---

export function detectMessagePatterns(
  tree: Parser.Tree,
  language: string,
  source: string,
  filePath: string,
  registry: ProtoRegistry
): MessageAnnotation[] {
  if (registry.getAllMessages().length === 0) return [];

  const out: MessageAnnotation[] = [];
  switch (language) {
    case "go":
      detectGo(tree.rootNode, source, filePath, registry, out);
      break;
    case "typescript":
    case "tsx":
    case "javascript":
      detectTypeScript(tree.rootNode, source, filePath, registry, out);
      break;
  }
  return out;
}
