import { dirname, join, resolve } from "node:path";

/**
 * Attempt to resolve a raw import source string (as extracted from the AST)
 * to an absolute file path that exists in the indexed file set.
 *
 * Returns null if the import cannot be resolved (e.g., stdlib, third-party,
 * or a language we don't know how to resolve).
 */
export function resolveImport(
  source: string,
  fromFilePath: string,
  language: string,
  filePathSet: Set<string>
): string | null {
  if (language === "python") {
    return resolvePythonImport(source, fromFilePath, filePathSet);
  }
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    return resolveJsImport(source, fromFilePath, filePathSet);
  }
  return null;
}

function resolvePythonImport(
  source: string,
  fromFilePath: string,
  filePathSet: Set<string>
): string | null {
  // Count leading dots (relative import markers)
  let dots = 0;
  let rest = source;
  while (rest.startsWith(".")) {
    dots++;
    rest = rest.slice(1);
  }

  const relPath = rest ? rest.split(".").join("/") : "";

  if (dots > 0) {
    // Relative import: 1 dot = same package dir, 2 dots = parent, etc.
    let base = dirname(fromFilePath);
    for (let i = 1; i < dots; i++) {
      base = dirname(base);
    }
    return tryPythonCandidates(base, relPath, filePathSet);
  }

  // Absolute import: try file's directory first, then walk up toward repo root.
  // filePathSet is scoped to the repo so no false matches outside it.
  let dir = dirname(fromFilePath);
  while (true) {
    const result = tryPythonCandidates(dir, relPath, filePathSet);
    if (result !== null) return result;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

function tryPythonCandidates(
  base: string,
  relPath: string,
  filePathSet: Set<string>
): string | null {
  const candidates = relPath
    ? [join(base, relPath + ".py"), join(base, relPath, "__init__.py")]
    : [join(base, "__init__.py")];

  for (const candidate of candidates) {
    if (filePathSet.has(candidate)) return candidate;
  }
  return null;
}

function resolveJsImport(
  source: string,
  fromFilePath: string,
  filePathSet: Set<string>
): string | null {
  if (!source.startsWith("./") && !source.startsWith("../")) return null;

  const base = resolve(dirname(fromFilePath), source);

  // Try the path as-is (already has extension)
  if (filePathSet.has(base)) return base;

  // Try common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = base + ext;
    if (filePathSet.has(candidate)) return candidate;
  }

  // Try as a directory index file
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = join(base, "index" + ext);
    if (filePathSet.has(candidate)) return candidate;
  }

  return null;
}
