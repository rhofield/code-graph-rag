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

function identifierTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_]+/).filter(Boolean);
}

function serviceReceiverAliases(serviceName: string): string[] {
  const aliases = new Set<string>([serviceName]);
  for (const suffix of ["Client", "Stub", "Server", "Service"]) {
    if (serviceName.endsWith(suffix) && serviceName.length > suffix.length) {
      aliases.add(serviceName.slice(0, -suffix.length));
    }
  }
  return [...aliases];
}

function pickByReceiver<T extends { serviceName: string; methodName: string }>(
  objText: string,
  defs: T[]
): T | null {
  const tokensLower = identifierTokens(objText).map((t) => t.toLowerCase());
  let match: T | null = null;
  for (const def of defs) {
    const aliases = serviceReceiverAliases(def.serviceName).map((a) => a.toLowerCase());
    if (aliases.some((a) => tokensLower.includes(a))) {
      if (match && match.serviceName !== def.serviceName) return null; // ambiguous → skip
      match = def;
    }
  }
  return match;
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
  if (node.type === "call_expression" || node.type === "call") {
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
            const picked = pickByReceiver(getNodeText(objNode, source), defs);
            if (picked) {
              out.push({
                functionName: enclosingFuncName,
                filePath,
                role: "caller",
                serviceName: picked.serviceName,
                methodName: picked.methodName,
              });
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
          const picked = pickByReceiver(getNodeText(objNode, source), defs);
          if (picked) {
            out.push({
              functionName: enclosingFuncName,
              filePath,
              role: "caller",
              serviceName: picked.serviceName,
              methodName: picked.methodName,
            });
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

function detectGoHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "method_declaration") {
      const receiver = node.childForFieldName("receiver");
      const methodNameNode = node.childForFieldName("name");
      if (receiver && methodNameNode) {
        const receiverText = getNodeText(receiver, source);
        const methodName = getNodeText(methodNameNode, source);
        for (const svcName of registry.getAllServices()) {
          if (receiverText.includes(svcName) && /Server[)\s,]/.test(receiverText + " ")) {
            const def = registry.lookup(svcName, methodName);
            if (def) {
              out.push({ functionName: methodName, filePath, role: "handler", serviceName: svcName, methodName: def.methodName });
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectGoCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}

function detectPythonHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_definition") {
      const argList = node.childForFieldName("superclasses");
      let matchedService: string | null = null;
      if (argList) {
        const baseText = getNodeText(argList, source);
        for (const svcName of registry.getAllServices()) {
          if (baseText.includes(svcName) && baseText.includes("Servicer")) {
            matchedService = svcName;
            break;
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "function_definition") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const def = registry.lookup(matchedService, methodName);
                if (def) {
                  out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectPythonCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}

function detectTypeScriptHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      let matchedService: string | null = null;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "class_heritage") {
          const text = getNodeText(child, source);
          for (const svcName of registry.getAllServices()) {
            if (text.includes(svcName) && text.includes("Server")) {
              matchedService = svcName;
              break;
            }
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "method_definition") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const defs = registry.lookupByMethod(methodName);
                for (const def of defs) {
                  if (def.serviceName === matchedService) {
                    out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectTypeScriptCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    // Named arrow / function-expression assigned to a const/let: pull the name
    // from the variable_declarator; the arrow itself has no `name` field.
    if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (
        nameNode &&
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
      ) {
        const body = valueNode.childForFieldName("body");
        if (body) findCallsInBody(body, source, getNodeText(nameNode, source), filePath, registry, out);
        return;
      }
    }

    if (node.type === "function_declaration" || node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }

    // Anonymous/unnamed arrow functions: skip — previously matched but had null name.
    if (node.type === "arrow_function" || node.type === "function_expression") {
      return;
    }

    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}

function detectJavaHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      let matchedService: string | null = null;
      const superclass = node.childForFieldName("superclass");
      if (superclass) {
        const superText = getNodeText(superclass, source);
        if (superText.includes("ImplBase")) {
          for (const svcName of registry.getAllServices()) {
            if (superText.includes(svcName)) {
              matchedService = svcName;
              break;
            }
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "method_declaration") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const defs = registry.lookupByMethod(methodName);
                for (const def of defs) {
                  if (def.serviceName === matchedService) {
                    out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectJavaCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkMethods(node: Parser.SyntaxNode): void {
    if (node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findJavaCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkMethods(node.child(i)!);
  }
  walkMethods(root);
}

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
