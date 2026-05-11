import type Parser from "web-tree-sitter";
import type { ProtoRegistry, ProtoRpcDef } from "./proto-registry.js";

export interface RpcAnnotation {
  functionName: string;
  filePath: string;
  role: "caller" | "handler" | "consumer";
  serviceName: string;
  methodName: string;
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function cleanPropertyName(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function pushUniqueAnnotation(out: RpcAnnotation[], annotation: RpcAnnotation): void {
  const exists = out.some((a) =>
    a.functionName === annotation.functionName &&
    a.filePath === annotation.filePath &&
    a.role === annotation.role &&
    a.serviceName === annotation.serviceName &&
    a.methodName === annotation.methodName
  );
  if (!exists) out.push(annotation);
}

function identifierTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_]+/).filter(Boolean);
}

function serviceNameTokens(serviceName: string): string[] {
  let name = serviceName;
  for (const suffix of ["Client", "Stub", "Server", "Service"]) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  const parts = name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
  return parts.map((p) => p.toLowerCase());
}

function pickByReceiver<T extends { serviceName: string }>(
  objText: string,
  defs: T[]
): T | null {
  const receiverTokens = new Set(identifierTokens(objText).flatMap((t) => {
    // Split receiver tokens by CamelCase too, so camelCase receivers tokenize
    // the same way snake_case ones do.
    const subs = t.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [t];
    return subs.map((s) => s.toLowerCase());
  }));

  let best: T | null = null;
  let bestScore = 0;
  let tied = false;
  for (const def of defs) {
    const nameTokens = serviceNameTokens(def.serviceName);
    if (nameTokens.length === 0) continue;
    let score = 0;
    for (const nt of nameTokens) {
      if (receiverTokens.has(nt)) score++;
    }
    if (score === 0) continue;
    if (score > bestScore) {
      best = def;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && best && best.serviceName !== def.serviceName) {
      tied = true;
    }
  }
  if (tied) return null;
  return best;
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
    if (child.type === "import_statement" || child.type === "export_statement") {
      const text = getNodeText(child, source);
      if (/_grpc_pb|ServiceClient|ServiceServer|grpc|protobufs|proto/i.test(text)) return true;
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

// Extract the trailing identifier from a Go type expression text
// (e.g. "pb.UnimplementedFooServer" -> "UnimplementedFooServer";
// "UnimplementedFooServer" -> "UnimplementedFooServer").
function trailingIdent(typeText: string): string {
  const trimmed = typeText.trim();
  const lastDot = trimmed.lastIndexOf(".");
  return lastDot >= 0 ? trimmed.slice(lastDot + 1) : trimmed;
}

// Extract the bare struct identifier from a Go method receiver subtree.
// Receiver is a parameter_list with one parameter_declaration whose type is
// either a pointer_type (*Foo) or a type_identifier (Foo). Returns null if
// it can't find one.
function extractReceiverStructName(receiver: Parser.SyntaxNode, source: string): string | null {
  for (let i = 0; i < receiver.childCount; i++) {
    const child = receiver.child(i)!;
    if (child.type === "parameter_declaration") {
      const typeNode = child.childForFieldName("type");
      if (!typeNode) continue;
      if (typeNode.type === "pointer_type") {
        // First (and typically only) child is the referenced type.
        for (let j = 0; j < typeNode.childCount; j++) {
          const t = typeNode.child(j)!;
          if (t.type === "type_identifier") return getNodeText(t, source);
          if (t.type === "qualified_type") return trailingIdent(getNodeText(t, source));
        }
        // Fallback: strip leading * from text.
        return getNodeText(typeNode, source).replace(/^\s*\*\s*/, "").trim();
      }
      if (typeNode.type === "type_identifier") {
        return getNodeText(typeNode, source);
      }
      if (typeNode.type === "qualified_type") {
        return trailingIdent(getNodeText(typeNode, source));
      }
    }
  }
  return null;
}

// Build a map from struct name -> list of service names the struct serves,
// based on embedded `Unimplemented<Service>Server` fields in struct_type
// field declarations. Only records service names present in the registry.
function buildGoStructServiceMap(
  root: Parser.SyntaxNode,
  source: string,
  registry: ProtoRegistry
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const knownServices = new Set(registry.getAllServices());

  function visitTypeSpec(typeSpec: Parser.SyntaxNode): void {
    const nameNode = typeSpec.childForFieldName("name");
    const typeNode = typeSpec.childForFieldName("type");
    if (!nameNode || !typeNode || typeNode.type !== "struct_type") return;
    const structName = getNodeText(nameNode, source);

    // struct_type contains a field_declaration_list.
    let fieldList: Parser.SyntaxNode | null = null;
    for (let i = 0; i < typeNode.childCount; i++) {
      const c = typeNode.child(i)!;
      if (c.type === "field_declaration_list") {
        fieldList = c;
        break;
      }
    }
    if (!fieldList) return;

    for (let i = 0; i < fieldList.childCount; i++) {
      const field = fieldList.child(i)!;
      if (field.type !== "field_declaration") continue;
      // Embedded field: no `name` field, only a `type` field.
      const fName = field.childForFieldName("name");
      if (fName) continue;
      const fType = field.childForFieldName("type");
      if (!fType) continue;
      const typeText = getNodeText(fType, source);
      const tail = trailingIdent(typeText);
      const m = tail.match(/^Unimplemented(.+)Server$/);
      if (!m) continue;
      const svcName = m[1];
      if (!knownServices.has(svcName)) continue;
      const existing = map.get(structName);
      if (existing) {
        if (!existing.includes(svcName)) existing.push(svcName);
      } else {
        map.set(structName, [svcName]);
      }
    }
  }

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "type_declaration") {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i)!;
        if (c.type === "type_spec") visitTypeSpec(c);
      }
      return;
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
  return map;
}

function detectGoHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  // First pass: find structs that embed Unimplemented<Service>Server.
  const structServices = buildGoStructServiceMap(root, source, registry);
  if (structServices.size === 0) return;

  // Second pass: attribute method_declarations to their receiver struct.
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "method_declaration") {
      const receiver = node.childForFieldName("receiver");
      const methodNameNode = node.childForFieldName("name");
      if (receiver && methodNameNode) {
        const structName = extractReceiverStructName(receiver, source);
        const methodName = getNodeText(methodNameNode, source);
        if (structName) {
          const services = structServices.get(structName);
          if (services) {
            for (const svcName of services) {
              const def = registry.lookup(svcName, methodName);
              if (def) {
                out.push({ functionName: methodName, filePath, role: "handler", serviceName: svcName, methodName: def.methodName });
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
    if (node.type === "pair") {
      const nameNode = node.childForFieldName("key");
      const valueNode = node.childForFieldName("value");
      if (
        nameNode &&
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
      ) {
        const body = valueNode.childForFieldName("body");
        if (body) {
          findCallsInBody(
            body,
            source,
            cleanPropertyName(getNodeText(nameNode, source)),
            filePath,
            registry,
            out
          );
        }
        return;
      }
    }

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

function parseNamedTypeScriptImports(importText: string): string[] {
  const named = importText.match(/\{([\s\S]*?)\}/);
  if (!named) return [];
  return named[1]
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((part) => {
      const alias = part.split(/\s+as\s+/i);
      return alias[alias.length - 1].trim();
    })
    .filter(Boolean);
}

function protoDefsForImportedName(name: string, registry: ProtoRegistry): ProtoRpcDef[] {
  const defs: ProtoRpcDef[] = [];
  for (const serviceName of registry.getAllServices()) {
    const serviceMethods = registry.getServiceMethods(serviceName);
    if (
      name === serviceName ||
      name === `${serviceName}Client` ||
      name === `${serviceName}PromiseClient` ||
      name === `${serviceName}Service`
    ) {
      defs.push(...serviceMethods);
      continue;
    }
    for (const def of serviceMethods) {
      if (name === def.requestType || name === def.responseType) {
        defs.push(def);
      }
    }
  }
  return defs;
}

function collectTypeScriptProtoImports(
  root: Parser.SyntaxNode,
  source: string,
  registry: ProtoRegistry
): Map<string, ProtoRpcDef[]> {
  const imports = new Map<string, ProtoRpcDef[]>();

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type !== "import_statement") continue;

    const text = getNodeText(child, source);
    const names = parseNamedTypeScriptImports(text);
    if (names.length === 0) continue;

    for (const name of names) {
      const defs = protoDefsForImportedName(name, registry);
      if (defs.length > 0) {
        imports.set(name, defs);
      }
    }
  }

  return imports;
}

function detectTypeScriptConsumers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  const protoImports = collectTypeScriptProtoImports(root, source, registry);
  if (protoImports.size === 0) return;

  function annotateIfUsesImportedProto(functionName: string, node: Parser.SyntaxNode): void {
    const text = getNodeText(node, source);
    for (const [localName, defs] of protoImports) {
      if (!new RegExp(`\\b${localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) continue;
      for (const def of defs) {
        pushUniqueAnnotation(out, {
          functionName,
          filePath,
          role: "consumer",
          serviceName: def.serviceName,
          methodName: def.methodName,
        });
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
        annotateIfUsesImportedProto(cleanPropertyName(getNodeText(nameNode, source)), valueNode);
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
        annotateIfUsesImportedProto(getNodeText(nameNode, source), valueNode);
        return;
      }
    }

    if (node.type === "function_declaration" || node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        annotateIfUsesImportedProto(getNodeText(nameNode, source), node);
        return;
      }
    }

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
  const hasDirectImports = hasGrpcImportsTypeScript(tree.rootNode, source);
  const out: RpcAnnotation[] = [];
  if (hasDirectImports) {
    detectTypeScriptHandlers(tree.rootNode, source, filePath, registry, out);
  }
  detectTypeScriptCalls(tree.rootNode, source, filePath, registry, out);
  detectTypeScriptConsumers(tree.rootNode, source, filePath, registry, out);
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
