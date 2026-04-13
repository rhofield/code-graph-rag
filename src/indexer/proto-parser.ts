import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProtoRegistry } from "./proto-registry.js";

function toCamelCase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function extractServiceBody(source: string, openBracePos: number): { body: string; endPos: number } {
  let depth = 1;
  let i = openBracePos + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return { body: source.slice(openBracePos + 1, i - 1), endPos: i };
}

export function parseProtoSource(
  source: string,
  filePath: string,
  registry: ProtoRegistry
): void {
  // Strip comments (block comments first, then line comments)
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  // Extract package name
  const pkgMatch = stripped.match(/package\s+([\w.]+)\s*;/);
  const packageName = pkgMatch ? pkgMatch[1] : "";

  // Extract services and their RPCs using brace-depth scanner
  const serviceRegex = /service\s+(\w+)\s*\{/g;
  const rpcRegex = /rpc\s+(\w+)\s*\(\s*(?:stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g;

  let serviceMatch: RegExpExecArray | null;
  while ((serviceMatch = serviceRegex.exec(stripped)) !== null) {
    const serviceName = serviceMatch[1];
    const openBracePos = serviceMatch.index + serviceMatch[0].length - 1;
    const { body: serviceBody, endPos } = extractServiceBody(stripped, openBracePos);
    serviceRegex.lastIndex = endPos; // advance past this service

    let rpcMatch: RegExpExecArray | null;
    rpcRegex.lastIndex = 0;
    while ((rpcMatch = rpcRegex.exec(serviceBody)) !== null) {
      registry.register({
        serviceName,
        methodName: rpcMatch[1],
        methodCamel: toCamelCase(rpcMatch[1]),
        requestType: rpcMatch[2],
        responseType: rpcMatch[3],
        packageName,
        protoFile: filePath,
      });
    }
  }
}

export function parseProtoFile(
  filePath: string,
  registry: ProtoRegistry
): void {
  const absPath = resolve(filePath);
  const source = readFileSync(absPath, "utf-8");
  parseProtoSource(source, absPath, registry);
}

export function parseProtoFiles(
  filePaths: string[],
  registry: ProtoRegistry
): void {
  for (const fp of filePaths) {
    parseProtoFile(fp, registry);
  }
}
