// src/indexer/parser.ts
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve, join } from "node:path";
import Parser from "web-tree-sitter";

let parser: Parser | null = null;
const languageCache = new Map<string, Parser.Language>();

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".html": "html",
  ".css": "css",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".lua": "lua",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".dart": "dart",
};

export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

export async function initParser(): Promise<void> {
  if (parser) return;
  await Parser.init();
  parser = new Parser();
}

async function loadLanguage(languageName: string): Promise<Parser.Language | null> {
  if (languageCache.has(languageName)) {
    return languageCache.get(languageName)!;
  }

  const wasmPath = join(
    "node_modules",
    "tree-sitter-wasms",
    "out",
    `tree-sitter-${languageName}.wasm`
  );

  if (!existsSync(wasmPath)) {
    return null;
  }

  const language = await Parser.Language.load(wasmPath);
  languageCache.set(languageName, language);
  return language;
}

export interface ParseResult {
  tree: Parser.Tree;
  language: string;
  source: string;
}

export async function parseFile(
  filePath: string
): Promise<ParseResult | null> {
  if (!parser) {
    await initParser();
  }

  const language = detectLanguage(filePath);
  if (!language) return null;

  const absPath = resolve(filePath);
  if (!existsSync(absPath)) return null;

  const lang = await loadLanguage(language);
  if (!lang) return null;

  parser!.setLanguage(lang);
  const source = readFileSync(absPath, "utf-8");
  const tree = parser!.parse(source);

  return { tree, language, source };
}
