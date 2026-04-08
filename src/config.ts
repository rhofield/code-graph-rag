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
    password: "rho-graph",
    managed: true,
  },
  index: {
    include: ["**/*"],
    exclude: [
      // VCS
      ".git",
      // JS/TS dependencies, build outputs, framework caches
      "node_modules",
      "bower_components",
      "dist",
      "build",
      "vendor",
      ".next",
      ".nuxt",
      "coverage",
      ".nyc_output",
      // Python virtual environments and vendored packages
      "venv",
      ".venv",
      "virtualenv",
      ".tox",
      "site-packages",
      // Python tool caches
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      // Rust / JVM build outputs
      "target",
      ".gradle",
      // IDE state
      ".idea",
      ".vscode",
      // Generic caches
      ".cache",
    ],
    languages: "auto",
  },
  repos: [],
};

function deepMerge(
  base: Config,
  override: Partial<Config>
): Config {
  const result: Config = structuredClone(base);
  if (override.neo4j) {
    result.neo4j = { ...result.neo4j, ...override.neo4j };
  }
  if (override.index) {
    result.index = { ...result.index, ...override.index };
  }
  if (override.repos) {
    result.repos = override.repos;
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

  // Global config: ~/.config/rho-graph/config.json
  const globalPath = join(
    homedir(),
    ".config",
    "rho-graph",
    "config.json"
  );
  const globalOverrides = loadJsonFile(globalPath);
  if (globalOverrides) {
    config = deepMerge(config, globalOverrides as Partial<Config>);
  }

  // Repo config: .rho-graph.json in repo root
  const repoPath = join(repoRoot, ".rho-graph.json");
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
