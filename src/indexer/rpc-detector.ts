import type Parser from "web-tree-sitter";
import type { ProtoRegistry } from "./proto-registry.js";

export interface RpcAnnotation {
  functionName: string;
  filePath: string;
  role: "caller" | "handler";
  serviceName: string;
  methodName: string;
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

// --- Gate checks: does this file import gRPC-generated code? ---

function hasGrpcImportsGo(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_declaration") {
      const text = getNodeText(child, source);
      if (/pb["'\s]|proto["'\s]|grpc["'\s]/i.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsPython(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_from_statement" || child.type === "import_statement") {
      const text = getNodeText(child, source);
      if (/_pb2_grpc|_pb2/.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsTypeScript(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_statement") {
      const text = getNodeText(child, source);
      if (/_grpc_pb|ServiceClient|ServiceServer|grpc/.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsJava(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_declaration") {
      const text = getNodeText(child, source);
      if (/Grpc[.;\s]|\.grpc\./.test(text)) return true;
    }
  }
  return false;
}

// --- Shared call-in-body finder for Go, Python, TypeScript ---

function findCallsInBody(
  node: Parser.SyntaxNode,
  source: string,
  enclosingFuncName: string,
  filePath: string,
  registry: ProtoRegistry,
  out: RpcAnnotation[]
): void {
  if (node.type === "call_expression") {
    const fnNode = node.childForFieldName("function");
    if (fnNode && (
      fnNode.type === "selector_expression" ||
      fnNode.type === "member_expression" ||
      fnNode.type === "attribute"
    )) {
      const fieldNode =
        fnNode.childForFieldName("field") ||
        fnNode.childForFieldName("property") ||
        fnNode.childForFieldName("attribute");
      if (fieldNode) {
        const callName = getNodeText(fieldNode, source);
        const defs = registry.lookupByMethod(callName);
        if (defs.length === 1) {
          out.push({
            functionName: enclosingFuncName,
            filePath,
            role: "caller",
            serviceName: defs[0].serviceName,
            methodName: defs[0].methodName,
          });
        } else if (defs.length > 1) {
          const objNode = fnNode.childForFieldName("operand") || fnNode.childForFieldName("object");
          if (objNode) {
            const objText = getNodeText(objNode, source).toLowerCase();
            for (const def of defs) {
              if (objText.includes(def.serviceName.toLowerCase().replace("service", ""))) {
                out.push({
                  functionName: enclosingFuncName,
                  filePath,
                  role: "caller",
                  serviceName: def.serviceName,
                  methodName: def.methodName,
                });
                break;
              }
            }
          }
        }
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    findCallsInBody(node.child(i)!, source, enclosingFuncName, filePath, registry, out);
  }
}

// --- Java-specific call finder (method_invocation instead of call_expression) ---

function findJavaCallsInBody(
  node: Parser.SyntaxNode,
  source: string,
  enclosingFuncName: string,
  filePath: string,
  registry: ProtoRegistry,
  out: RpcAnnotation[]
): void {
  if (node.type === "method_invocation") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const callName = getNodeText(nameNode, source);
      const defs = registry.lookupByMethod(callName);
      if (defs.length === 1) {
        out.push({
          functionName: enclosingFuncName,
          filePath,
          role: "caller",
          serviceName: defs[0].serviceName,
          methodName: defs[0].methodName,
        });
      } else if (defs.length > 1) {
        const objNode = node.childForFieldName("object");
        if (objNode) {
          const objText = getNodeText(objNode, source).toLowerCase();
          for (const def of defs) {
            if (objText.includes(def.serviceName.toLowerCase().replace("service", ""))) {
              out.push({
                functionName: enclosingFuncName,
                filePath,
                role: "caller",
                serviceName: def.serviceName,
                methodName: def.methodName,
              });
              break;
            }
          }
        }
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    findJavaCallsInBody(node.child(i)!, source, enclosingFuncName, filePath, registry, out);
  }
}

// --- Handler/caller detection stubs (filled in Task 5) ---

function detectGoHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectGoCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectPythonHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectPythonCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectTypeScriptHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectTypeScriptCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectJavaHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectJavaCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}

// --- Per-language dispatch ---

function detectGo(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsGo(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectGoHandlers(tree.rootNode, source, filePath, registry, out);
  detectGoCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectPython(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsPython(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectPythonHandlers(tree.rootNode, source, filePath, registry, out);
  detectPythonCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectTypeScript(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsTypeScript(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectTypeScriptHandlers(tree.rootNode, source, filePath, registry, out);
  detectTypeScriptCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectJava(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsJava(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectJavaHandlers(tree.rootNode, source, filePath, registry, out);
  detectJavaCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

// --- Main entry point ---

export function detectRpcPatterns(
  tree: Parser.Tree,
  language: string,
  source: string,
  filePath: string,
  registry: ProtoRegistry
): RpcAnnotation[] {
  if (registry.getAllServices().length === 0) return [];

  switch (language) {
    case "go": return detectGo(tree, source, filePath, registry);
    case "python": return detectPython(tree, source, filePath, registry);
    case "typescript":
    case "tsx":
    case "javascript": return detectTypeScript(tree, source, filePath, registry);
    case "java": return detectJava(tree, source, filePath, registry);
    default: return [];
  }
}
