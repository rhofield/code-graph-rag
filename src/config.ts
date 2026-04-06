import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  managed: boolean;
}

export interface IndexConfig {
  include: string[];
  exclude: string[];
  languages: string;
}

export interface RepoEntry {
  path: string;
  name: string;
}

export interface Config {
  neo4j: Neo4jConfig;
  index: IndexConfig;
  repos: RepoEntry[];
}

export const DEFAULT_CONFIG: Config = {
  neo4j: {
    uri: "bolt://localhost:7687",
    username: "neo4j",
    password: "code-graph-rag",
    managed: true,
  },
  index: {
    include: ["**/*"],
    exclude: ["node_modules", "dist", "vendor", ".git", "build", "__pycache__"],
    languages: "auto",
  },
  repos: [],
};

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>
): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (
      val !== undefined &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      val !== null
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

function loadJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

export function loadConfig(repoRoot: string): Config {
  let config: Config = structuredClone(DEFAULT_CONFIG);

  // Global config: ~/.config/code-graph-rag/config.json
  const globalPath = join(
    homedir(),
    ".config",
    "code-graph-rag",
    "config.json"
  );
  const globalOverrides = loadJsonFile(globalPath);
  if (globalOverrides) {
    config = deepMerge(config, globalOverrides as Partial<Config>);
  }

  // Repo config: .code-graph-rag.json in repo root
  const repoPath = join(repoRoot, ".code-graph-rag.json");
  const repoOverrides = loadJsonFile(repoPath);
  if (repoOverrides) {
    config = deepMerge(config, repoOverrides as Partial<Config>);
  }

  // Environment variable overrides
  if (process.env.NEO4J_URI) {
    config.neo4j.uri = process.env.NEO4J_URI;
  }
  if (process.env.NEO4J_USERNAME) {
    config.neo4j.username = process.env.NEO4J_USERNAME;
  }
  if (process.env.NEO4J_PASSWORD) {
    config.neo4j.password = process.env.NEO4J_PASSWORD;
  }

  return config;
}
