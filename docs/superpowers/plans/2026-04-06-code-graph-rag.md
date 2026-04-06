# Code Graph RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a graph-RAG code indexer that gives AI agents token-efficient code search via MCP tools backed by Neo4j.

**Architecture:** Separated indexer (write path) + MCP server (read path) sharing a Neo4j database. The indexer uses tree-sitter to parse source code into a multi-level graph (repository to file to class to function) with call and import relationships. The MCP server exposes query tools that AI agents use instead of reading raw files.

**Tech Stack:** TypeScript, Neo4j (via `neo4j-driver`), `web-tree-sitter` (WASM-based parsing), `@modelcontextprotocol/sdk` (MCP server), `commander` (CLI), `vitest` (testing)

**Spec:** `docs/superpowers/specs/2026-04-06-code-graph-rag-design.md`

**Safety note:** All shell command execution in the implementation MUST use `execFileSync`/`execFile` with argument arrays (not `exec` with string interpolation) to prevent command injection. For example: `execFileSync("docker", ["inspect", containerName])` not `exec("docker inspect " + containerName)`.

---

## File Map

### New files to create

**Root config:**
- `package.json` — Project manifest, dependencies, scripts, bin entry
- `tsconfig.json` — TypeScript compiler config
- `docker-compose.yml` — Neo4j container definition
- `vitest.config.ts` — Test runner config

**Source — Config:**
- `src/config.ts` — Load and merge config from defaults, repo file, global file, env vars

**Source — DB layer:**
- `src/db/connection.ts` — Neo4j driver setup, connection pooling, health check
- `src/db/schema.ts` — Create indexes, constraints, full-text indexes on Neo4j
- `src/db/queries.ts` — Reusable Cypher query builders for all node/relationship operations

**Source — Docker:**
- `src/docker/neo4j.ts` — Start/stop/status of managed Neo4j Docker container

**Source — Indexer:**
- `src/indexer/language-map.json` — Node type names per language for tree-sitter extraction
- `src/indexer/parser.ts` — Tree-sitter init, language detection, parse file to AST
- `src/indexer/extractor.ts` — Walk AST using language map, emit graph entities
- `src/indexer/graph-writer.ts` — Batch upsert graph entities to Neo4j via MERGE
- `src/indexer/staleness.ts` — File hash/mtime comparison for change detection
- `src/indexer/index.ts` — Orchestrate: discover files, parse, extract, write, update staleness

**Source — MCP Server:**
- `src/mcp/index.ts` — MCP stdio server setup, tool registration
- `src/mcp/staleness-check.ts` — Query-time freshness middleware
- `src/mcp/tools/search-code.ts` — Full-text search across functions/classes
- `src/mcp/tools/get-function.ts` — Retrieve a specific function's code
- `src/mcp/tools/get-class.ts` — Retrieve a class and its methods
- `src/mcp/tools/get-file-structure.ts` — List symbols in a file (no bodies)
- `src/mcp/tools/get-callers.ts` — Find functions that call a target
- `src/mcp/tools/get-callees.ts` — Find functions called by a target
- `src/mcp/tools/get-dependencies.ts` — Import graph for a file
- `src/mcp/tools/get-dependents.ts` — Reverse import graph
- `src/mcp/tools/get-repo-structure.ts` — Bird's-eye directory/symbol tree
- `src/mcp/tools/reindex.ts` — Trigger re-indexing from MCP

**Source — CLI:**
- `src/cli/index.ts` — CLI entry point, commander setup, command registration
- `src/cli/commands/init.ts` — Start Neo4j, create schema, run first index
- `src/cli/commands/index-cmd.ts` — Re-index (full, --changed, --path, --repo)
- `src/cli/commands/status.ts` — Show index status and staleness
- `src/cli/commands/setup.ts` — Full setup shortcut (init + install-mcp + install-hook)
- `src/cli/commands/install-mcp.ts` — Register MCP server in Claude Code config
- `src/cli/commands/install-hook.ts` — Install git post-commit hook
- `src/cli/commands/query.ts` — Interactive Cypher REPL and query shortcuts
- `src/cli/commands/visualize.ts` — Launch browser-based graph visualization

**Source — Visualization:**
- `src/visualize/server.ts` — Local HTTP server for graph UI
- `src/visualize/public/index.html` — Graph visualization HTML shell
- `src/visualize/public/graph.js` — Graph rendering with vis-network

**Entry point:**
- `bin/code-graph-rag.js` — Shebang entry point

**Tests:**
- `tests/config.test.ts`
- `tests/db/connection.test.ts`
- `tests/db/schema.test.ts`
- `tests/db/queries.test.ts`
- `tests/indexer/parser.test.ts`
- `tests/indexer/extractor.test.ts`
- `tests/indexer/graph-writer.test.ts`
- `tests/indexer/staleness.test.ts`
- `tests/indexer/index.test.ts`
- `tests/mcp/tools.test.ts`
- `tests/mcp/staleness-check.test.ts`
- `tests/integration/microservices.test.ts`
- `tests/e2e/setup.test.ts`

**Test fixtures:**
- `tests/fixtures/sample.ts`
- `tests/fixtures/sample.py`
- `tests/fixtures/sample.go`
- `tests/fixtures/sample.graphql`
- `tests/fixtures/cross-file-a.ts`
- `tests/fixtures/cross-file-b.ts`
- `tests/fixtures/microservices/auth-service/src/index.ts`
- `tests/fixtures/microservices/auth-service/src/auth.ts`
- `tests/fixtures/microservices/auth-service/src/session.ts`
- `tests/fixtures/microservices/auth-service/package.json`
- `tests/fixtures/microservices/api-gateway/src/index.ts`
- `tests/fixtures/microservices/api-gateway/src/router.ts`
- `tests/fixtures/microservices/api-gateway/src/middleware.ts`
- `tests/fixtures/microservices/api-gateway/package.json`
- `tests/fixtures/microservices/user-service/src/index.ts`
- `tests/fixtures/microservices/user-service/src/user.ts`
- `tests/fixtures/microservices/user-service/src/profile.ts`
- `tests/fixtures/microservices/user-service/package.json`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `bin/code-graph-rag.js`
- Create: `docker-compose.yml`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "code-graph-rag",
  "version": "0.1.0",
  "description": "Graph-RAG code indexer for AI agents — token-efficient code search via MCP tools backed by Neo4j",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "code-graph-rag": "./bin/code-graph-rag.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "neo4j-driver": "^5.27.0",
    "web-tree-sitter": "^0.24.3",
    "@anthropic-ai/sdk": "^0.39.0",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "glob": "^11.0.1",
    "ora": "^8.1.1",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=18"
  },
  "files": [
    "dist",
    "bin",
    "src/indexer/language-map.json",
    "src/visualize/public",
    "docker-compose.yml"
  ]
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

- [ ] **Step 4: Create bin/code-graph-rag.js**

```javascript
#!/usr/bin/env node
import "../dist/cli/index.js";
```

- [ ] **Step 5: Create docker-compose.yml**

```yaml
services:
  neo4j:
    image: neo4j:5-community
    container_name: code-graph-rag-neo4j
    ports:
      - "7474:7474"
      - "7687:7687"
    environment:
      NEO4J_AUTH: neo4j/code-graph-rag
      NEO4J_PLUGINS: '[]'
    volumes:
      - code-graph-rag-data:/data
    restart: unless-stopped

volumes:
  code-graph-rag-data:
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
*.tgz
.code-graph-rag.json
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 8: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, should be clean)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts bin/code-graph-rag.js docker-compose.yml .gitignore
git commit -m "feat: scaffold project with dependencies and build config"
```

---

## Task 2: Config System

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type Config, DEFAULT_CONFIG } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cgr-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://localhost:7687");
    expect(config.neo4j.managed).toBe(true);
    expect(config.index.exclude).toContain("node_modules");
  });

  it("merges repo config file over defaults", () => {
    const repoConfig = {
      neo4j: { uri: "bolt://custom:7687" },
      index: { exclude: ["vendor"] },
    };
    writeFileSync(
      join(tempDir, ".code-graph-rag.json"),
      JSON.stringify(repoConfig)
    );
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://custom:7687");
    expect(config.neo4j.managed).toBe(true); // default preserved
    expect(config.index.exclude).toContain("vendor");
  });

  it("respects NEO4J_URI environment variable", () => {
    process.env.NEO4J_URI = "bolt://env-host:7687";
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://env-host:7687");
    delete process.env.NEO4J_URI;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`

- [ ] **Step 3: Write the implementation**

```typescript
// src/config.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config system with defaults, file, and env var merging"
```

---

## Task 3: Neo4j Connection Layer

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/schema.ts`
- Create: `tests/db/connection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/connection.test.ts
import { describe, it, expect } from "vitest";
import { createConnection } from "../../src/db/connection.js";

describe("createConnection", () => {
  it("creates a connection with the provided config", () => {
    const conn = createConnection({
      uri: "bolt://localhost:7687",
      username: "neo4j",
      password: "code-graph-rag",
    });
    expect(conn).toBeDefined();
    expect(conn.driver).toBeDefined();
    expect(typeof conn.close).toBe("function");
    expect(typeof conn.healthCheck).toBe("function");
    conn.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write connection implementation**

```typescript
// src/db/connection.ts
import neo4j, { type Driver, type Session } from "neo4j-driver";

export interface ConnectionConfig {
  uri: string;
  username: string;
  password: string;
}

export interface DbConnection {
  driver: Driver;
  session(): Session;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export function createConnection(config: ConnectionConfig): DbConnection {
  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.username, config.password)
  );

  return {
    driver,
    session() {
      return driver.session();
    },
    async healthCheck() {
      try {
        const session = driver.session();
        await session.run("RETURN 1");
        await session.close();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await driver.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: PASS

- [ ] **Step 5: Write schema setup**

```typescript
// src/db/schema.ts
import type { DbConnection } from "./connection.js";

export async function setupSchema(db: DbConnection): Promise<void> {
  const session = db.session();
  try {
    // Uniqueness constraints
    await session.run(
      "CREATE CONSTRAINT repo_path IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT file_path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE"
    );

    // Indexes for fast lookup
    await session.run(
      "CREATE INDEX function_name IF NOT EXISTS FOR (f:Function) ON (f.name)"
    );
    await session.run(
      "CREATE INDEX class_name IF NOT EXISTS FOR (c:Class) ON (c.name)"
    );
    await session.run(
      "CREATE INDEX file_language IF NOT EXISTS FOR (f:File) ON (f.language)"
    );

    // Full-text index for search_code
    await session.run(`
      CREATE FULLTEXT INDEX code_search IF NOT EXISTS
      FOR (n:Function|Class)
      ON EACH [n.name, n.snippet, n.docstring]
    `);
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/db/connection.ts src/db/schema.ts tests/db/connection.test.ts
git commit -m "feat: add Neo4j connection layer and schema setup"
```

---

## Task 4: Cypher Query Builders

**Files:**
- Create: `src/db/queries.ts`
- Create: `tests/db/queries.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/queries.test.ts
import { describe, it, expect } from "vitest";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
  upsertImportRelationship,
  deleteFileAndRelationships,
} from "../../src/db/queries.js";

describe("query builders", () => {
  it("upsertRepository returns valid cypher and params", () => {
    const { cypher, params } = upsertRepository({
      path: "/home/user/project",
      name: "project",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Repository");
    expect(params.path).toBe("/home/user/project");
    expect(params.name).toBe("project");
  });

  it("upsertFile returns valid cypher and params", () => {
    const { cypher, params } = upsertFile({
      path: "/home/user/project/src/index.ts",
      relativePath: "src/index.ts",
      repoPath: "/home/user/project",
      language: "typescript",
      hash: "abc123",
      lastModified: 1700000000,
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":File");
    expect(cypher).toContain("CONTAINS_FILE");
    expect(params.path).toBe("/home/user/project/src/index.ts");
  });

  it("upsertFunction returns valid cypher and params", () => {
    const { cypher, params } = upsertFunction({
      name: "greet",
      filePath: "/home/user/project/src/index.ts",
      startLine: 1,
      endLine: 5,
      signature: "function greet(name: string): string",
      docstring: null,
      snippet: "function greet(name: string): string {\n  return `Hello ${name}`;\n}",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Function");
    expect(cypher).toContain("CONTAINS");
    expect(params.name).toBe("greet");
  });

  it("upsertClass returns valid cypher and params", () => {
    const { cypher, params } = upsertClass({
      name: "UserService",
      filePath: "/home/user/project/src/user.ts",
      startLine: 1,
      endLine: 20,
      docstring: "Handles user operations",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Class");
    expect(params.name).toBe("UserService");
  });

  it("upsertCallRelationship returns valid cypher", () => {
    const { cypher, params } = upsertCallRelationship({
      callerName: "handleRequest",
      callerFilePath: "/home/user/project/src/router.ts",
      calleeName: "validateToken",
    });
    expect(cypher).toContain("CALLS");
    expect(params.callerName).toBe("handleRequest");
    expect(params.calleeName).toBe("validateToken");
  });

  it("upsertImportRelationship returns valid cypher", () => {
    const { cypher, params } = upsertImportRelationship({
      sourceFilePath: "/home/user/project/src/router.ts",
      targetFilePath: "/home/user/project/src/auth.ts",
    });
    expect(cypher).toContain("IMPORTS");
    expect(params.sourceFilePath).toBe("/home/user/project/src/router.ts");
  });

  it("deleteFileAndRelationships returns valid cypher", () => {
    const { cypher, params } = deleteFileAndRelationships({
      filePath: "/home/user/project/src/old.ts",
    });
    expect(cypher).toContain("DETACH DELETE");
    expect(params.filePath).toBe("/home/user/project/src/old.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/queries.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/db/queries.ts

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

export function upsertRepository(data: {
  path: string;
  name: string;
}): CypherQuery {
  return {
    cypher: `
      MERGE (r:Repository {path: $path})
      SET r.name = $name, r.lastIndexedAt = datetime()
    `,
    params: data,
  };
}

export function upsertFile(data: {
  path: string;
  relativePath: string;
  repoPath: string;
  language: string;
  hash: string;
  lastModified: number;
}): CypherQuery {
  return {
    cypher: `
      MATCH (r:Repository {path: $repoPath})
      MERGE (f:File {path: $path})
      SET f.relativePath = $relativePath,
          f.language = $language,
          f.hash = $hash,
          f.lastModified = $lastModified
      MERGE (r)-[:CONTAINS_FILE]->(f)
    `,
    params: data,
  };
}

export function upsertFunction(data: {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string | null;
  snippet: string;
  className?: string;
}): CypherQuery {
  if (data.className) {
    return {
      cypher: `
        MATCH (c:Class {name: $className})<-[:CONTAINS]-(:File {path: $filePath})
        MERGE (fn:Function {name: $name, filePath: $filePath, className: $className})
        SET fn.startLine = $startLine,
            fn.endLine = $endLine,
            fn.signature = $signature,
            fn.docstring = $docstring,
            fn.snippet = $snippet
        MERGE (c)-[:HAS_METHOD]->(fn)
      `,
      params: data,
    };
  }
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MERGE (fn:Function {name: $name, filePath: $filePath})
      ON CREATE SET fn.className = null
      SET fn.startLine = $startLine,
          fn.endLine = $endLine,
          fn.signature = $signature,
          fn.docstring = $docstring,
          fn.snippet = $snippet
      MERGE (f)-[:CONTAINS]->(fn)
    `,
    params: { ...data, className: null },
  };
}

export function upsertClass(data: {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  docstring: string | null;
}): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MERGE (c:Class {name: $name, filePath: $filePath})
      SET c.startLine = $startLine,
          c.endLine = $endLine,
          c.docstring = $docstring
      MERGE (f)-[:CONTAINS]->(c)
    `,
    params: data,
  };
}

export function upsertCallRelationship(data: {
  callerName: string;
  callerFilePath: string;
  calleeName: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (caller:Function {name: $callerName, filePath: $callerFilePath})
      MATCH (callee:Function {name: $calleeName})
      MERGE (caller)-[:CALLS]->(callee)
    `,
    params: data,
  };
}

export function upsertImportRelationship(data: {
  sourceFilePath: string;
  targetFilePath: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (source:File {path: $sourceFilePath})
      MATCH (target:File {path: $targetFilePath})
      MERGE (source)-[:IMPORTS]->(target)
    `,
    params: data,
  };
}

export function upsertImportSymbol(data: {
  sourceFilePath: string;
  symbolName: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (source:File {path: $sourceFilePath})
      MATCH (symbol) WHERE (symbol:Function OR symbol:Class) AND symbol.name = $symbolName
      MERGE (source)-[:IMPORTS_SYMBOL]->(symbol)
    `,
    params: data,
  };
}

export function deleteFileAndRelationships(data: {
  filePath: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      OPTIONAL MATCH (f)-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child, f
    `,
    params: data,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/queries.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts tests/db/queries.test.ts
git commit -m "feat: add Cypher query builders for all graph operations"
```

---

## Task 5: Docker Management

**Files:**
- Create: `src/docker/neo4j.ts`

- [ ] **Step 1: Write the implementation**

No unit test for this module — it wraps Docker CLI commands and is best verified by the E2E tests (Task 23). Testing Docker interactions with mocks provides little value.

```typescript
// src/docker/neo4j.ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CONTAINER_NAME = "code-graph-rag-neo4j";

function runDocker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

export function isDockerAvailable(): boolean {
  try {
    runDocker("info");
    return true;
  } catch {
    return false;
  }
}

export function getContainerStatus(): "running" | "stopped" | "not_found" {
  try {
    const result = runDocker(
      "inspect",
      "--format",
      "{{.State.Running}}",
      CONTAINER_NAME
    ).trim();
    return result === "true" ? "running" : "stopped";
  } catch {
    return "not_found";
  }
}

export function startNeo4j(composeFilePath: string): void {
  const status = getContainerStatus();
  if (status === "running") return;
  if (status === "stopped") {
    runDocker("start", CONTAINER_NAME);
    return;
  }
  const composePath = resolve(composeFilePath);
  execFileSync("docker", ["compose", "-f", composePath, "up", "-d"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

export function stopNeo4j(): void {
  const status = getContainerStatus();
  if (status === "running") {
    runDocker("stop", CONTAINER_NAME);
  }
}

export async function waitForNeo4j(
  _uri: string,
  maxAttempts = 30
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER_NAME, "neo4j-admin", "server", "status"],
        { encoding: "utf-8", stdio: "pipe" }
      );
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/docker/neo4j.ts
git commit -m "feat: add Docker management for Neo4j container"
```

---

## Task 6: Test Fixtures

**Files:**
- Create: `tests/fixtures/sample.ts`
- Create: `tests/fixtures/sample.py`
- Create: `tests/fixtures/sample.go`
- Create: `tests/fixtures/sample.graphql`
- Create: `tests/fixtures/cross-file-a.ts`
- Create: `tests/fixtures/cross-file-b.ts`

- [ ] **Step 1: Create TypeScript fixture**

```typescript
// tests/fixtures/sample.ts

/** Greets a user by name */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export class UserService {
  /** Creates a new user */
  createUser(name: string, email: string): User {
    const validated = validateEmail(email);
    return { name, email: validated };
  }

  getUser(id: number): User | null {
    return null;
  }
}

function validateEmail(email: string): string {
  if (!email.includes("@")) {
    throw new Error("Invalid email");
  }
  return email.toLowerCase();
}

interface User {
  name: string;
  email: string;
}
```

- [ ] **Step 2: Create Python fixture**

```python
# tests/fixtures/sample.py

"""Sample Python module for testing."""

import os
from pathlib import Path


def greet(name: str) -> str:
    """Greets a user by name."""
    return f"Hello, {name}!"


class UserService:
    """Handles user operations."""

    def create_user(self, name: str, email: str) -> dict:
        """Creates a new user."""
        validated = validate_email(email)
        return {"name": name, "email": validated}

    def get_user(self, user_id: int) -> dict | None:
        return None


def validate_email(email: str) -> str:
    if "@" not in email:
        raise ValueError("Invalid email")
    return email.lower()
```

- [ ] **Step 3: Create Go fixture**

```go
// tests/fixtures/sample.go
package main

import "fmt"

// Greet greets a user by name.
func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

// UserService handles user operations.
type UserService struct{}

// CreateUser creates a new user.
func (s *UserService) CreateUser(name, email string) (User, error) {
	validated, err := ValidateEmail(email)
	if err != nil {
		return User{}, err
	}
	return User{Name: name, Email: validated}, nil
}

// ValidateEmail validates an email address.
func ValidateEmail(email string) (string, error) {
	for _, c := range email {
		if c == '@' {
			return email, nil
		}
	}
	return "", fmt.Errorf("invalid email")
}

type User struct {
	Name  string
	Email string
}
```

- [ ] **Step 4: Create GraphQL fixture**

```graphql
# tests/fixtures/sample.graphql

type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  body: String!
  author: User!
}

input CreateUserInput {
  name: String!
  email: String!
}

type Query {
  user(id: ID!): User
  users: [User!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}
```

- [ ] **Step 5: Create cross-file fixtures for import/call testing**

```typescript
// tests/fixtures/cross-file-a.ts
export function validateToken(token: string): boolean {
  return token.length > 0;
}

export class AuthService {
  authenticate(token: string): boolean {
    return validateToken(token);
  }
}
```

```typescript
// tests/fixtures/cross-file-b.ts
import { validateToken, AuthService } from "./cross-file-a";

export function handleRequest(token: string): string {
  if (!validateToken(token)) {
    return "unauthorized";
  }
  return "ok";
}

export class Router {
  private auth = new AuthService();

  route(token: string): string {
    return handleRequest(token);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/
git commit -m "feat: add test fixtures for TypeScript, Python, Go, GraphQL, and cross-file references"
```

---

## Task 7: Tree-Sitter Parser

**Files:**
- Create: `src/indexer/parser.ts`
- Create: `tests/indexer/parser.test.ts`

- [ ] **Step 1: Install tree-sitter WASM grammars**

Run: `npm install tree-sitter-wasms`

This package bundles pre-built WASM grammars for all major languages. Each grammar is available as a `.wasm` file at `node_modules/tree-sitter-wasms/out/tree-sitter-<language>.wasm`.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/indexer/parser.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  initParser,
  parseFile,
  detectLanguage,
} from "../../src/indexer/parser.js";

describe("detectLanguage", () => {
  it("detects typescript from .ts extension", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
  });

  it("detects python from .py extension", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("detects go from .go extension", () => {
    expect(detectLanguage("main.go")).toBe("go");
  });

  it("detects tsx from .tsx extension", () => {
    expect(detectLanguage("App.tsx")).toBe("tsx");
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("data.xyz")).toBeNull();
  });
});

describe("parseFile", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a TypeScript file and returns a result", async () => {
    const result = await parseFile("tests/fixtures/sample.ts");
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe("program");
    expect(result!.language).toBe("typescript");
  });

  it("parses a Python file and returns a result", async () => {
    const result = await parseFile("tests/fixtures/sample.py");
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe("module");
    expect(result!.language).toBe("python");
  });

  it("returns null for unsupported file types", async () => {
    const result = await parseFile("tests/fixtures/unknown.xyz");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/indexer/parser.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 4: Write the implementation**

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/indexer/parser.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/indexer/parser.ts tests/indexer/parser.test.ts package.json package-lock.json
git commit -m "feat: add tree-sitter parser with language detection and WASM grammar loading"
```

---

## Task 8: Language Map and Extractor

**Files:**
- Create: `src/indexer/language-map.json`
- Create: `src/indexer/extractor.ts`
- Create: `tests/indexer/extractor.test.ts`

- [ ] **Step 1: Create the language map**

```json
{
  "typescript": {
    "function": ["function_declaration", "arrow_function", "method_definition"],
    "class": ["class_declaration"],
    "import": ["import_statement"],
    "call": ["call_expression"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "tsx": {
    "function": ["function_declaration", "arrow_function", "method_definition"],
    "class": ["class_declaration"],
    "import": ["import_statement"],
    "call": ["call_expression"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "javascript": {
    "function": ["function_declaration", "arrow_function", "method_definition"],
    "class": ["class_declaration"],
    "import": ["import_statement"],
    "call": ["call_expression"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "python": {
    "function": ["function_definition"],
    "class": ["class_definition"],
    "import": ["import_from_statement", "import_statement"],
    "call": ["call"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "go": {
    "function": ["function_declaration", "method_declaration"],
    "class": ["type_declaration"],
    "import": ["import_declaration", "import_spec"],
    "call": ["call_expression"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "java": {
    "function": ["method_declaration", "constructor_declaration"],
    "class": ["class_declaration", "interface_declaration", "enum_declaration"],
    "import": ["import_declaration"],
    "call": ["method_invocation"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "rust": {
    "function": ["function_item"],
    "class": ["struct_item", "enum_item", "trait_item", "impl_item"],
    "import": ["use_declaration"],
    "call": ["call_expression"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "c": {
    "function": ["function_definition"],
    "class": ["struct_specifier"],
    "import": ["preproc_include"],
    "call": ["call_expression"],
    "name_field": "declarator",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "cpp": {
    "function": ["function_definition"],
    "class": ["class_specifier", "struct_specifier"],
    "import": ["preproc_include"],
    "call": ["call_expression"],
    "name_field": "declarator",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "ruby": {
    "function": ["method", "singleton_method"],
    "class": ["class", "module"],
    "import": ["call"],
    "call": ["call", "method_call"],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "parameters"
  },
  "graphql": {
    "function": ["operation_definition", "fragment_definition"],
    "class": ["object_type_definition", "input_object_type_definition", "interface_type_definition", "enum_type_definition"],
    "import": [],
    "call": [],
    "name_field": "name",
    "body_field": "body",
    "parameters_field": "arguments_definition"
  }
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/indexer/extractor.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { initParser, parseFile } from "../../src/indexer/parser.js";
import { extractGraphEntities, type GraphEntities } from "../../src/indexer/extractor.js";

describe("extractGraphEntities", () => {
  beforeAll(async () => {
    await initParser();
  });

  describe("TypeScript extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.ts");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.ts"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("greet");
      expect(funcNames).toContain("validateEmail");
    });

    it("extracts classes", () => {
      const classNames = entities.classes.map((c) => c.name);
      expect(classNames).toContain("UserService");
    });

    it("extracts methods inside classes", () => {
      const methods = entities.functions.filter(
        (f) => f.className === "UserService"
      );
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain("createUser");
      expect(methodNames).toContain("getUser");
    });

    it("extracts function signatures", () => {
      const greet = entities.functions.find((f) => f.name === "greet");
      expect(greet!.signature).toContain("greet");
    });

    it("extracts code snippets", () => {
      const greet = entities.functions.find((f) => f.name === "greet");
      expect(greet!.snippet).toContain("Hello");
    });

    it("extracts call relationships", () => {
      const calls = entities.calls;
      const callNames = calls.map((c) => ({
        caller: c.callerName,
        callee: c.calleeName,
      }));
      expect(callNames).toContainEqual({
        caller: "createUser",
        callee: "validateEmail",
      });
    });
  });

  describe("Python extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.py");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.py"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("greet");
      expect(funcNames).toContain("validate_email");
    });

    it("extracts classes", () => {
      const classNames = entities.classes.map((c) => c.name);
      expect(classNames).toContain("UserService");
    });

    it("extracts imports", () => {
      expect(entities.imports.length).toBeGreaterThan(0);
    });
  });

  describe("Go extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.go");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.go"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("Greet");
      expect(funcNames).toContain("ValidateEmail");
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/indexer/extractor.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 4: Write the implementation**

```typescript
// src/indexer/extractor.ts
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Parser from "web-tree-sitter";

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
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
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

  if (!mapping) {
    return { functions, classes, imports, calls };
  }

  const functionTypes = new Set(mapping.function);
  const classTypes = new Set(mapping.class);
  const importTypes = new Set(mapping.import);

  function walkNode(
    node: Parser.SyntaxNode,
    currentClassName: string | null
  ): void {
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
      const nameNode = node.childForFieldName(mapping.name_field);
      if (nameNode) {
        const funcName = getNodeText(nameNode, source);
        const snippet = getNodeText(node, source);
        const signature = extractSignature(node, source);

        functions.push({
          name: funcName,
          filePath: absPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature,
          docstring: getDocstring(node, source),
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

  walkNode(tree.rootNode, null);

  return { functions, classes, imports, calls };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/indexer/extractor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/indexer/language-map.json src/indexer/extractor.ts tests/indexer/extractor.test.ts
git commit -m "feat: add AST extractor with language map for multi-language graph entity extraction"
```

---

## Task 9: Graph Writer

**Files:**
- Create: `src/indexer/graph-writer.ts`
- Create: `tests/indexer/graph-writer.test.ts`

- [ ] **Step 1: Write the failing test**

This test uses mocks since we test real Neo4j in integration tests.

```typescript
// tests/indexer/graph-writer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeGraphEntities } from "../../src/indexer/graph-writer.js";
import type { GraphEntities } from "../../src/indexer/extractor.js";

const mockRun = vi.fn().mockResolvedValue({ records: [] });
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSession = { run: mockRun, close: mockClose };
const mockDb = {
  driver: {},
  session: () => mockSession,
  healthCheck: vi.fn(),
  close: vi.fn(),
};

describe("writeGraphEntities", () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it("writes repository, file, functions, classes, and calls", async () => {
    const entities: GraphEntities = {
      functions: [
        {
          name: "greet",
          filePath: "/project/src/index.ts",
          startLine: 1,
          endLine: 3,
          signature: "function greet(name: string): string",
          docstring: "Greets a user",
          snippet: "function greet(name: string) { return 'hi'; }",
          className: null,
        },
      ],
      classes: [
        {
          name: "UserService",
          filePath: "/project/src/index.ts",
          startLine: 5,
          endLine: 20,
          docstring: "User ops",
        },
      ],
      imports: [],
      calls: [
        {
          callerName: "greet",
          callerFilePath: "/project/src/index.ts",
          calleeName: "validate",
        },
      ],
    };

    await writeGraphEntities(mockDb as any, entities, {
      filePath: "/project/src/index.ts",
      relativePath: "src/index.ts",
      repoPath: "/project",
      language: "typescript",
      hash: "abc123",
      lastModified: 1700000000,
    });

    // Should have run queries for: repo, file, delete old children, re-link file, class, function, call
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("handles empty entities without error", async () => {
    const entities: GraphEntities = {
      functions: [],
      classes: [],
      imports: [],
      calls: [],
    };

    await writeGraphEntities(mockDb as any, entities, {
      filePath: "/project/src/empty.ts",
      relativePath: "src/empty.ts",
      repoPath: "/project",
      language: "typescript",
      hash: "def456",
      lastModified: 1700000000,
    });

    // Should still write repo and file nodes
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/graph-writer.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/indexer/graph-writer.ts
import type { DbConnection } from "../db/connection.js";
import type { GraphEntities } from "./extractor.js";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
} from "../db/queries.js";

export interface FileMetadata {
  filePath: string;
  relativePath: string;
  repoPath: string;
  language: string;
  hash: string;
  lastModified: number;
}

export async function writeGraphEntities(
  db: DbConnection,
  entities: GraphEntities,
  meta: FileMetadata
): Promise<void> {
  const session = db.session();
  try {
    // Upsert repository
    const repoQ = upsertRepository({
      path: meta.repoPath,
      name: meta.repoPath.split("/").pop() || meta.repoPath,
    });
    await session.run(repoQ.cypher, repoQ.params);

    // Upsert file
    const fileQ = upsertFile(meta);
    await session.run(fileQ.cypher, fileQ.params);

    // Delete old children for this file (clean re-index)
    await session.run(
      `
      MATCH (f:File {path: $filePath})-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child
      `,
      { filePath: meta.filePath }
    );

    // Re-link file to repo (in case delete removed it)
    await session.run(fileQ.cypher, fileQ.params);

    // Upsert classes
    for (const cls of entities.classes) {
      const q = upsertClass({
        name: cls.name,
        filePath: meta.filePath,
        startLine: cls.startLine,
        endLine: cls.endLine,
        docstring: cls.docstring,
      });
      await session.run(q.cypher, q.params);
    }

    // Upsert functions
    for (const fn of entities.functions) {
      const q = upsertFunction({
        name: fn.name,
        filePath: meta.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        signature: fn.signature,
        docstring: fn.docstring,
        snippet: fn.snippet,
        className: fn.className ?? undefined,
      });
      await session.run(q.cypher, q.params);
    }

    // Upsert call relationships
    for (const call of entities.calls) {
      const q = upsertCallRelationship(call);
      await session.run(q.cypher, q.params);
    }
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/graph-writer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/graph-writer.ts tests/indexer/graph-writer.test.ts
git commit -m "feat: add graph writer for batch upserting entities to Neo4j"
```

---

## Task 10: Staleness Detection

**Files:**
- Create: `src/indexer/staleness.ts`
- Create: `tests/indexer/staleness.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/indexer/staleness.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFileHash, isFileStale } from "../../src/indexer/staleness.js";

describe("staleness detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cgr-stale-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeFileHash", () => {
    it("returns consistent hash for same content", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const hash1 = computeFileHash(file);
      const hash2 = computeFileHash(file);
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different content", () => {
      const file1 = join(tempDir, "a.ts");
      const file2 = join(tempDir, "b.ts");
      writeFileSync(file1, "const x = 1;");
      writeFileSync(file2, "const x = 2;");
      expect(computeFileHash(file1)).not.toBe(computeFileHash(file2));
    });
  });

  describe("isFileStale", () => {
    it("returns true when hash differs", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const oldHash = computeFileHash(file);
      writeFileSync(file, "const x = 2;");
      expect(isFileStale(file, oldHash, 0)).toBe(true);
    });

    it("returns false when hash matches", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const hash = computeFileHash(file);
      expect(isFileStale(file, hash, Date.now())).toBe(false);
    });

    it("returns true when file does not exist (deleted)", () => {
      expect(isFileStale("/nonexistent/file.ts", "abc", 0)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/staleness.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/indexer/staleness.ts
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function getFileMtime(filePath: string): number {
  const stat = statSync(filePath);
  return stat.mtimeMs;
}

export function isFileStale(
  filePath: string,
  storedHash: string,
  storedMtime: number
): boolean {
  if (!existsSync(filePath)) {
    return true; // File was deleted
  }

  const currentMtime = getFileMtime(filePath);
  if (currentMtime <= storedMtime) {
    return false; // mtime hasn't changed, skip expensive hash
  }

  const currentHash = computeFileHash(filePath);
  return currentHash !== storedHash;
}

export function getChangedFilesSinceCommit(repoPath: string): string[] {
  try {
    const result = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result
      .trim()
      .split("\n")
      .filter((f: string) => f.length > 0);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/staleness.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/staleness.ts tests/indexer/staleness.test.ts
git commit -m "feat: add staleness detection via file hash and mtime comparison"
```

---

## Task 11: Indexer Orchestrator

**Files:**
- Create: `src/indexer/index.ts`
- Create: `tests/indexer/index.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/indexer/index.test.ts
import { describe, it, expect } from "vitest";
import { discoverFiles } from "../../src/indexer/index.js";

describe("discoverFiles", () => {
  it("discovers fixture files", async () => {
    const files = await discoverFiles("tests/fixtures", {
      include: ["**/*.ts", "**/*.py", "**/*.go", "**/*.graphql"],
      exclude: ["node_modules"],
      languages: "auto",
    });
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(".ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(".py"))).toBe(true);
    expect(files.some((f) => f.endsWith(".go"))).toBe(true);
  });

  it("respects exclude patterns", async () => {
    const files = await discoverFiles("tests/fixtures", {
      include: ["**/*.ts"],
      exclude: ["**/cross-file*"],
      languages: "auto",
    });
    expect(files.every((f) => !f.includes("cross-file"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/index.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/indexer/index.ts
import { resolve, relative } from "node:path";
import { glob } from "glob";
import type { DbConnection } from "../db/connection.js";
import type { IndexConfig } from "../config.js";
import { initParser, parseFile, detectLanguage } from "./parser.js";
import { extractGraphEntities } from "./extractor.js";
import { writeGraphEntities } from "./graph-writer.js";
import { computeFileHash, getFileMtime, isFileStale } from "./staleness.js";

export async function discoverFiles(
  rootPath: string,
  config: IndexConfig
): Promise<string[]> {
  const absRoot = resolve(rootPath);
  const allFiles: string[] = [];

  for (const pattern of config.include) {
    const matches = await glob(pattern, {
      cwd: absRoot,
      absolute: true,
      ignore: config.exclude.map((e) =>
        e.includes("/") ? e : `**/${e}/**`
      ),
      nodir: true,
    });
    allFiles.push(...matches);
  }

  return [...new Set(allFiles)];
}

export interface IndexResult {
  filesIndexed: number;
  functionsFound: number;
  classesFound: number;
  errors: Array<{ file: string; error: string }>;
}

export async function indexRepository(
  db: DbConnection,
  repoPath: string,
  config: IndexConfig,
  options: {
    changedOnly?: boolean;
    specificPath?: string;
    onProgress?: (current: number, total: number, file: string) => void;
  } = {}
): Promise<IndexResult> {
  const absRoot = resolve(repoPath);
  await initParser();

  let files: string[];
  if (options.specificPath) {
    files = await discoverFiles(resolve(absRoot, options.specificPath), config);
  } else {
    files = await discoverFiles(absRoot, config);
  }

  // Filter to supported languages
  files = files.filter((f) => detectLanguage(f) !== null);

  // If changedOnly, check staleness against existing graph
  if (options.changedOnly) {
    const session = db.session();
    try {
      const result = await session.run(
        "MATCH (f:File) WHERE f.path STARTS WITH $repoPath RETURN f.path AS path, f.hash AS hash, f.lastModified AS lastModified",
        { repoPath: absRoot }
      );
      const indexed = new Map(
        result.records.map((r) => [
          r.get("path"),
          { hash: r.get("hash"), lastModified: r.get("lastModified") },
        ])
      );
      files = files.filter((f) => {
        const existing = indexed.get(f);
        if (!existing) return true; // New file
        return isFileStale(f, existing.hash, existing.lastModified);
      });
    } finally {
      await session.close();
    }
  }

  const result: IndexResult = {
    filesIndexed: 0,
    functionsFound: 0,
    classesFound: 0,
    errors: [],
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    options.onProgress?.(i + 1, files.length, file);

    try {
      const parseResult = await parseFile(file);
      if (!parseResult) continue;

      const entities = extractGraphEntities(
        parseResult.tree,
        parseResult.language,
        parseResult.source,
        file
      );

      await writeGraphEntities(db, entities, {
        filePath: file,
        relativePath: relative(absRoot, file),
        repoPath: absRoot,
        language: parseResult.language,
        hash: computeFileHash(file),
        lastModified: getFileMtime(file),
      });

      result.filesIndexed++;
      result.functionsFound += entities.functions.length;
      result.classesFound += entities.classes.length;
    } catch (error) {
      result.errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/index.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/index.ts tests/indexer/index.test.ts
git commit -m "feat: add indexer orchestrator with file discovery, incremental indexing, and progress reporting"
```

---

## Task 12: CLI Framework and Core Commands

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/commands/init.ts`
- Create: `src/cli/commands/index-cmd.ts`
- Create: `src/cli/commands/status.ts`
- Create: `src/cli/commands/setup.ts`

- [ ] **Step 1: Create CLI entry point**

```typescript
// src/cli/index.ts
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerInstallMcpCommand } from "./commands/install-mcp.js";
import { registerInstallHookCommand } from "./commands/install-hook.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerVisualizeCommand } from "./commands/visualize.js";

const program = new Command();

program
  .name("code-graph-rag")
  .description(
    "Graph-RAG code indexer — token-efficient code search for AI agents"
  )
  .version("0.1.0");

registerInitCommand(program);
registerIndexCommand(program);
registerStatusCommand(program);
registerSetupCommand(program);
registerInstallMcpCommand(program);
registerInstallHookCommand(program);
registerQueryCommand(program);
registerVisualizeCommand(program);

program.parse();
```

- [ ] **Step 2: Create init command**

```typescript
// src/cli/commands/init.ts
import { Command } from "commander";
import ora from "ora";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { setupSchema } from "../../db/schema.js";
import {
  isDockerAvailable,
  startNeo4j,
  waitForNeo4j,
} from "../../docker/neo4j.js";
import { indexRepository } from "../../indexer/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Neo4j and index the current repository")
    .action(async () => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);

      if (config.neo4j.managed) {
        const spinner = ora("Checking prerequisites...").start();
        if (!isDockerAvailable()) {
          spinner.fail(
            "Docker is not available. Install Docker or set neo4j.managed to false."
          );
          process.exit(1);
        }
        spinner.succeed("Docker available");

        const neo4jSpinner = ora("Starting Neo4j...").start();
        const composePath = resolve(__dirname, "../../../docker-compose.yml");
        startNeo4j(composePath);
        const ready = await waitForNeo4j(config.neo4j.uri);
        if (!ready) {
          neo4jSpinner.fail("Neo4j failed to start");
          process.exit(1);
        }
        neo4jSpinner.succeed("Neo4j running");
      }

      const db = createConnection(config.neo4j);
      const schemaSpinner = ora("Setting up schema...").start();
      await setupSchema(db);
      schemaSpinner.succeed("Schema ready");

      const indexSpinner = ora("Indexing repository...").start();
      const result = await indexRepository(db, repoPath, config.index, {
        onProgress: (current, total) => {
          indexSpinner.text = `Indexing... ${current}/${total}`;
        },
      });
      indexSpinner.succeed(
        `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes`
      );

      if (result.errors.length > 0) {
        console.log(`\n${result.errors.length} files had errors:`);
        for (const err of result.errors.slice(0, 5)) {
          console.log(`  ${err.file}: ${err.error}`);
        }
      }

      await db.close();
    });
}
```

- [ ] **Step 3: Create index command**

```typescript
// src/cli/commands/index-cmd.ts
import { Command } from "commander";
import ora from "ora";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { indexRepository } from "../../indexer/index.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description("Re-index the repository")
    .option("--changed", "Only index changed files")
    .option("--path <path>", "Index a specific path")
    .option("--repo <repoPath>", "Index a different repository")
    .action(async (opts) => {
      const repoPath = resolve(opts.repo || ".");
      const config = loadConfig(repoPath);
      const db = createConnection(config.neo4j);

      const spinner = ora("Indexing...").start();
      const result = await indexRepository(db, repoPath, config.index, {
        changedOnly: opts.changed,
        specificPath: opts.path,
        onProgress: (current, total) => {
          spinner.text = `Indexing... ${current}/${total}`;
        },
      });
      spinner.succeed(
        `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes`
      );

      if (result.errors.length > 0) {
        console.log(`\n${result.errors.length} files had errors:`);
        for (const err of result.errors.slice(0, 5)) {
          console.log(`  ${err.file}: ${err.error}`);
        }
      }

      await db.close();
    });
}
```

- [ ] **Step 4: Create status command**

```typescript
// src/cli/commands/status.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show index status")
    .action(async () => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);
      const db = createConnection(config.neo4j);

      const healthy = await db.healthCheck();
      if (!healthy) {
        console.log(
          "Neo4j is not running. Run `code-graph-rag init` to start it."
        );
        process.exit(1);
      }

      const session = db.session();
      try {
        const repos = await session.run(
          "MATCH (r:Repository) RETURN r.name AS name, r.path AS path, r.lastIndexedAt AS lastIndexed"
        );
        const files = await session.run(
          "MATCH (f:File) RETURN f.language AS language, count(f) AS count"
        );
        const functions = await session.run(
          "MATCH (fn:Function) RETURN count(fn) AS count"
        );
        const classes = await session.run(
          "MATCH (c:Class) RETURN count(c) AS count"
        );

        console.log("\nRepositories:");
        for (const r of repos.records) {
          console.log(
            `  ${r.get("name")} (${r.get("path")}) — last indexed: ${r.get("lastIndexed")}`
          );
        }

        console.log("\nFiles by language:");
        for (const f of files.records) {
          console.log(`  ${f.get("language")}: ${f.get("count")}`);
        }

        console.log(
          `\nFunctions: ${functions.records[0]?.get("count") ?? 0}`
        );
        console.log(`Classes: ${classes.records[0]?.get("count") ?? 0}`);
      } finally {
        await session.close();
        await db.close();
      }
    });
}
```

- [ ] **Step 5: Create setup command (delegates to init, install-mcp, install-hook)**

```typescript
// src/cli/commands/setup.ts
import { Command } from "commander";

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Full setup: init + install MCP server + install git hook")
    .action(async () => {
      // Sequentially invoke subcommands
      await parent.parseAsync(["node", "code-graph-rag", "init"], {
        from: "user",
      });
      await parent.parseAsync(["node", "code-graph-rag", "install-mcp"], {
        from: "user",
      });
      await parent.parseAsync(["node", "code-graph-rag", "install-hook"], {
        from: "user",
      });

      console.log(
        "\nReady! Your AI agent now has access to graph-powered code search."
      );
    });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/
git commit -m "feat: add CLI framework with init, index, status, and setup commands"
```

---

## Task 13: Install Commands

**Files:**
- Create: `src/cli/commands/install-mcp.ts`
- Create: `src/cli/commands/install-hook.ts`

- [ ] **Step 1: Create install-mcp command**

```typescript
// src/cli/commands/install-mcp.ts
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import ora from "ora";

export function registerInstallMcpCommand(program: Command): void {
  program
    .command("install-mcp")
    .description("Register the MCP server in Claude Code settings")
    .action(async () => {
      const spinner = ora("Installing MCP server...").start();

      const claudeDir = join(homedir(), ".claude");
      const settingsPath = join(claudeDir, "settings.json");

      if (!existsSync(claudeDir)) {
        mkdirSync(claudeDir, { recursive: true });
      }

      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }

      const mcpServers =
        (settings.mcpServers as Record<string, unknown>) || {};
      mcpServers["code-graph-rag"] = {
        command: "npx",
        args: ["code-graph-rag", "mcp-serve"],
        type: "stdio",
      };
      settings.mcpServers = mcpServers;

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      spinner.succeed("MCP server registered in ~/.claude/settings.json");
    });
}
```

- [ ] **Step 2: Create install-hook command**

```typescript
// src/cli/commands/install-hook.ts
import { Command } from "commander";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import ora from "ora";

const HOOK_CONTENT = `#!/bin/sh
# code-graph-rag: re-index changed files after commit
code-graph-rag index --changed &
`;

export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description("Install git post-commit hook for automatic re-indexing")
    .action(async () => {
      const spinner = ora("Installing git hook...").start();
      const repoRoot = resolve(".");
      const hookDir = join(repoRoot, ".git", "hooks");

      if (!existsSync(join(repoRoot, ".git"))) {
        spinner.fail("Not a git repository");
        process.exit(1);
      }

      const hookPath = join(hookDir, "post-commit");

      if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, "utf-8");
        if (existing.includes("code-graph-rag")) {
          spinner.succeed("Hook already installed");
          return;
        }
        writeFileSync(hookPath, existing + "\n" + HOOK_CONTENT);
      } else {
        writeFileSync(hookPath, HOOK_CONTENT);
      }

      chmodSync(hookPath, 0o755);
      spinner.succeed(`Hook installed at ${hookPath}`);
    });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/install-mcp.ts src/cli/commands/install-hook.ts
git commit -m "feat: add install-mcp and install-hook CLI commands"
```

---

## Task 14: MCP Server Setup

**Files:**
- Create: `src/mcp/index.ts`

- [ ] **Step 1: Write the MCP server entry point**

```typescript
// src/mcp/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createConnection } from "../db/connection.js";
import { registerSearchCode } from "./tools/search-code.js";
import { registerGetFunction } from "./tools/get-function.js";
import { registerGetClass } from "./tools/get-class.js";
import { registerGetFileStructure } from "./tools/get-file-structure.js";
import { registerGetCallers } from "./tools/get-callers.js";
import { registerGetCallees } from "./tools/get-callees.js";
import { registerGetDependencies } from "./tools/get-dependencies.js";
import { registerGetDependents } from "./tools/get-dependents.js";
import { registerGetRepoStructure } from "./tools/get-repo-structure.js";
import { registerReindex } from "./tools/reindex.js";

export async function startMcpServer(): Promise<void> {
  const repoPath = resolve(".");
  const config = loadConfig(repoPath);
  const db = createConnection(config.neo4j);

  const server = new McpServer({
    name: "code-graph-rag",
    version: "0.1.0",
  });

  registerSearchCode(server, db);
  registerGetFunction(server, db);
  registerGetClass(server, db);
  registerGetFileStructure(server, db);
  registerGetCallers(server, db);
  registerGetCallees(server, db);
  registerGetDependencies(server, db);
  registerGetDependents(server, db);
  registerGetRepoStructure(server, db);
  registerReindex(server, db, config, repoPath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Add mcp-serve command to CLI**

Add to `src/cli/index.ts` before `program.parse()`:

```typescript
program
  .command("mcp-serve")
  .description("Start the MCP server (used by Claude Code)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/index.js");
    await startMcpServer();
  });
```

- [ ] **Step 3: Commit**

```bash
git add src/mcp/index.ts src/cli/index.ts
git commit -m "feat: add MCP server entry point with tool registration"
```

---

## Task 15: MCP Search and Retrieval Tools

**Files:**
- Create: `src/mcp/tools/search-code.ts`
- Create: `src/mcp/tools/get-function.ts`
- Create: `src/mcp/tools/get-class.ts`
- Create: `src/mcp/tools/get-file-structure.ts`
- Create: `src/mcp/tools/get-repo-structure.ts`

Each file follows the same pattern: export a `register*` function that calls `server.tool()` with a name, description, zod schema, and handler that runs a Cypher query and returns JSON results.

Full code for each tool is provided in the spec section "MCP Tools". Implement each tool with these patterns:

- Use `z` from `zod` for parameter schemas
- Run Cypher via `db.session()`, always close the session in `finally`
- Return `{ content: [{ type: "text", text: JSON.stringify(results, null, 2) }] }`
- Tool descriptions MUST include the "use this instead of..." enforcement language from the spec

Refer to the full tool implementations shown in the spec's MCP Server section (Section 3) for the exact Cypher queries and response shapes.

- [ ] **Step 1: Create search-code.ts** — Full-text search using Neo4j fulltext index
- [ ] **Step 2: Create get-function.ts** — Lookup by name with optional filePath disambiguation
- [ ] **Step 3: Create get-class.ts** — Lookup class + collect methods via HAS_METHOD
- [ ] **Step 4: Create get-file-structure.ts** — File symbols without code bodies
- [ ] **Step 5: Create get-repo-structure.ts** — Directory tree with file counts and symbols
- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/search-code.ts src/mcp/tools/get-function.ts src/mcp/tools/get-class.ts src/mcp/tools/get-file-structure.ts src/mcp/tools/get-repo-structure.ts
git commit -m "feat: add MCP search and retrieval tools"
```

---

## Task 16: MCP Graph Traversal Tools

**Files:**
- Create: `src/mcp/tools/get-callers.ts`
- Create: `src/mcp/tools/get-callees.ts`
- Create: `src/mcp/tools/get-dependencies.ts`
- Create: `src/mcp/tools/get-dependents.ts`
- Create: `src/mcp/tools/reindex.ts`

Same pattern as Task 15. Each tool runs a focused Cypher query over CALLS or IMPORTS relationships.

- [ ] **Step 1: Create get-callers.ts** — `MATCH (caller)-[:CALLS]->(callee {name: $name})`
- [ ] **Step 2: Create get-callees.ts** — `MATCH (caller {name: $name})-[:CALLS]->(callee)`
- [ ] **Step 3: Create get-dependencies.ts** — `MATCH (f:File)-[:IMPORTS]->(dep:File)`
- [ ] **Step 4: Create get-dependents.ts** — `MATCH (dependent:File)-[:IMPORTS]->(f:File)`
- [ ] **Step 5: Create reindex.ts** — Calls `indexRepository` with `specificPath` or `changedOnly`
- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/
git commit -m "feat: add MCP graph traversal tools and reindex tool"
```

---

## Task 17: MCP Staleness Check Middleware

**Files:**
- Create: `src/mcp/staleness-check.ts`
- Create: `tests/mcp/staleness-check.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/staleness-check.test.ts
import { describe, it, expect, vi } from "vitest";
import { checkStaleness } from "../../src/mcp/staleness-check.js";

describe("checkStaleness", () => {
  it("returns fresh when no files are stale", async () => {
    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: (key: string) => {
              const data: Record<string, unknown> = {
                path: "/project/src/index.ts",
                hash: "abc123",
                lastModified: Date.now(),
              };
              return data[key];
            },
          },
        ],
      }),
      close: vi.fn(),
    };

    const result = await checkStaleness(
      { session: () => mockSession } as any,
      ["/project/src/index.ts"],
      () => false
    );

    expect(result.staleFiles).toHaveLength(0);
    expect(result.needsWarning).toBe(false);
  });

  it("returns warning when more than 20 files are stale", async () => {
    const stalePaths = Array.from(
      { length: 25 },
      (_, i) => `/project/src/file${i}.ts`
    );
    const records = stalePaths.map((path) => ({
      get: (key: string) => {
        const data: Record<string, unknown> = {
          path,
          hash: "old",
          lastModified: 0,
        };
        return data[key];
      },
    }));

    const mockSession = {
      run: vi.fn().mockResolvedValue({ records }),
      close: vi.fn(),
    };

    const result = await checkStaleness(
      { session: () => mockSession } as any,
      stalePaths,
      () => true
    );

    expect(result.staleFiles.length).toBe(25);
    expect(result.needsWarning).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/staleness-check.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/mcp/staleness-check.ts
import type { DbConnection } from "../db/connection.js";
import { isFileStale as defaultIsFileStale } from "../indexer/staleness.js";

const STALE_THRESHOLD = 20;

export interface StalenessResult {
  staleFiles: string[];
  needsWarning: boolean;
}

export async function checkStaleness(
  db: DbConnection,
  filePaths: string[],
  isStaleCheck: (
    filePath: string,
    storedHash: string,
    storedMtime: number
  ) => boolean = defaultIsFileStale
): Promise<StalenessResult> {
  if (filePaths.length === 0) {
    return { staleFiles: [], needsWarning: false };
  }

  const session = db.session();
  try {
    const result = await session.run(
      "MATCH (f:File) WHERE f.path IN $paths RETURN f.path AS path, f.hash AS hash, f.lastModified AS lastModified",
      { paths: filePaths }
    );

    const staleFiles: string[] = [];
    for (const record of result.records) {
      const path = record.get("path") as string;
      const hash = record.get("hash") as string;
      const lastModified = record.get("lastModified") as number;

      if (isStaleCheck(path, hash, lastModified)) {
        staleFiles.push(path);
      }
    }

    return {
      staleFiles,
      needsWarning: staleFiles.length > STALE_THRESHOLD,
    };
  } finally {
    await session.close();
  }
}

export function formatStalenessWarning(staleCount: number): string {
  return `Warning: Index is stale for ${staleCount} files. Run \`code-graph-rag index --changed\` for full refresh.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/staleness-check.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/staleness-check.ts tests/mcp/staleness-check.test.ts
git commit -m "feat: add query-time staleness check middleware for MCP tools"
```

---

## Task 18: Query CLI Command

**Files:**
- Create: `src/cli/commands/query.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/cli/commands/query.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../../config.js";
import { createConnection, type DbConnection } from "../../db/connection.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query [cypher]")
    .description(
      "Run Cypher queries against the graph (interactive REPL if no query given)"
    )
    .option("--callers <functionName>", "Find all callers of a function")
    .option("--dependencies <filePath>", "Find dependencies of a file")
    .option("--structure", "Show high-level repo structure")
    .action(async (cypher, opts) => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);
      const db = createConnection(config.neo4j);

      const healthy = await db.healthCheck();
      if (!healthy) {
        console.log(
          "Neo4j is not running. Run `code-graph-rag init` to start it."
        );
        process.exit(1);
      }

      if (opts.callers) {
        cypher =
          "MATCH (caller:Function)-[:CALLS]->(callee:Function {name: $name}) RETURN caller.name AS caller, caller.filePath AS file, caller.startLine AS line";
      } else if (opts.dependencies) {
        cypher =
          "MATCH (f:File)-[:IMPORTS]->(dep:File) WHERE f.relativePath = $path OR f.path ENDS WITH $path RETURN dep.relativePath AS dependency";
      } else if (opts.structure) {
        cypher =
          "MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File) RETURN r.name AS repo, f.language AS language, count(f) AS files ORDER BY files DESC";
      }

      if (cypher) {
        const params: Record<string, string> = {};
        if (opts.callers) params.name = opts.callers;
        if (opts.dependencies) params.path = opts.dependencies;
        await runQuery(db, cypher, params);
        await db.close();
        return;
      }

      // Interactive REPL
      console.log("code-graph-rag query REPL (type 'exit' to quit)\n");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "cypher> ",
      });

      rl.prompt();
      rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (trimmed === "exit" || trimmed === "quit") {
          await db.close();
          rl.close();
          return;
        }
        if (trimmed) {
          await runQuery(db, trimmed, {});
        }
        rl.prompt();
      });
    });
}

async function runQuery(
  db: DbConnection,
  cypher: string,
  params: Record<string, unknown>
): Promise<void> {
  const session = db.session();
  try {
    const result = await session.run(cypher, params);
    if (result.records.length === 0) {
      console.log("(no results)");
      return;
    }

    const keys = result.records[0].keys;
    console.log(keys.join("\t"));
    console.log(keys.map(() => "---").join("\t"));
    for (const record of result.records) {
      const values = keys.map((k) => {
        const v = record.get(k);
        return typeof v === "object" ? JSON.stringify(v) : String(v);
      });
      console.log(values.join("\t"));
    }
    console.log(`\n${result.records.length} row(s)`);
  } catch (error) {
    console.error(
      `Query error: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/commands/query.ts
git commit -m "feat: add interactive Cypher query CLI with predefined shortcuts"
```

---

## Task 19: Visualization

**Files:**
- Create: `src/cli/commands/visualize.ts`
- Create: `src/visualize/server.ts`
- Create: `src/visualize/public/index.html`
- Create: `src/visualize/public/graph.js`

- [ ] **Step 1: Create visualize command**

```typescript
// src/cli/commands/visualize.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { startVisualizationServer } from "../../visualize/server.js";

export function registerVisualizeCommand(program: Command): void {
  program
    .command("visualize")
    .description("Open browser-based graph visualization")
    .option("--repo <name>", "Filter by repository")
    .option("--file <path>", "Focus on a specific file")
    .option("--function <name>", "Focus on a specific function")
    .option("--port <port>", "Server port", "3333")
    .action(async (opts) => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);
      await startVisualizationServer({
        neo4jConfig: config.neo4j,
        port: parseInt(opts.port),
        filter: {
          repo: opts.repo,
          file: opts.file,
          function: opts.function,
        },
      });
    });
}
```

- [ ] **Step 2: Create visualization server**

The server serves static HTML/JS files and exposes a `/api/graph` endpoint that queries Neo4j and returns nodes and edges as JSON. Uses `node:http` createServer (no Express dependency). Opens the browser on start via platform-specific `open` command using `execFileSync`.

- [ ] **Step 3: Create index.html** — Minimal HTML shell that loads vis-network from CDN and graph.js
- [ ] **Step 4: Create graph.js** — Fetches `/api/graph`, renders with vis-network. Color-codes by node type (File=blue, Class=red, Function=purple). Click to show details panel with snippet.
- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/visualize.ts src/visualize/
git commit -m "feat: add browser-based graph visualization with vis-network"
```

---

## Task 20: Microservice Test Fixtures

**Files:**
- Create: All files under `tests/fixtures/microservices/`

- [ ] **Step 1: Create auth-service fixtures** (index.ts, auth.ts with validateToken/generateToken, session.ts with SessionManager class, package.json)
- [ ] **Step 2: Create api-gateway fixtures** (index.ts, router.ts with Router class that calls authMiddleware, middleware.ts with authMiddleware/rateLimiter, package.json)
- [ ] **Step 3: Create user-service fixtures** (index.ts, user.ts with UserController class, profile.ts with ProfileService that imports UserController, package.json)
- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/microservices/
git commit -m "feat: add microservice test fixtures (auth-service, api-gateway, user-service)"
```

---

## Task 21: Integration Tests

**Files:**
- Create: `tests/integration/microservices.test.ts`
- Create: `tests/mcp/tools.test.ts`

These tests require a running Neo4j instance. They are gated with `describe.skipIf(!process.env.INTEGRATION)` so they only run when `INTEGRATION=1` is set.

- [ ] **Step 1: Create microservice integration tests** — Index all 3 fixture repos, verify: 3 Repository nodes, files scoped to repos, same filename across repos produces distinct nodes, functions are extractable, cross-repo search works
- [ ] **Step 2: Create MCP tools integration test** — Index single-repo fixtures, verify: full-text search finds functions, get_callers finds call relationships, file structure returns symbols
- [ ] **Step 3: Commit**

```bash
git add tests/integration/ tests/mcp/tools.test.ts
git commit -m "feat: add integration tests for microservices and MCP tools"
```

---

## Task 22: Final Wiring and Build Verification

**Files:**
- Verify all imports resolve
- Verify TypeScript compilation succeeds
- Verify all unit tests pass

- [ ] **Step 1: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

Fix any import path issues or missing type declarations.

- [ ] **Step 2: Run all unit tests**

Run: `npx vitest run`
Expected: All non-integration tests PASS

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build issues and verify all unit tests pass"
```

---

## Task 23: End-to-End Smoke Test

**Files:**
- Create: `tests/e2e/setup.test.ts`

- [ ] **Step 1: Create E2E test**

Gated with `describe.skipIf(!process.env.INTEGRATION)`. Creates a temp git repo with a sample source file, runs `init` against it, verifies the graph was populated, then runs `install-hook` and verifies the hook file exists.

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/
git commit -m "feat: add E2E smoke test for setup flow"
```

---

## Summary

| Task | Component | Key Files |
|------|-----------|-----------|
| 1 | Project scaffolding | package.json, tsconfig.json, docker-compose.yml |
| 2 | Config system | src/config.ts |
| 3 | Neo4j connection | src/db/connection.ts, src/db/schema.ts |
| 4 | Cypher queries | src/db/queries.ts |
| 5 | Docker management | src/docker/neo4j.ts |
| 6 | Test fixtures | tests/fixtures/ |
| 7 | Tree-sitter parser | src/indexer/parser.ts |
| 8 | Extractor + language map | src/indexer/extractor.ts, language-map.json |
| 9 | Graph writer | src/indexer/graph-writer.ts |
| 10 | Staleness detection | src/indexer/staleness.ts |
| 11 | Indexer orchestrator | src/indexer/index.ts |
| 12 | CLI framework | src/cli/index.ts, commands/init,index,status,setup |
| 13 | Install commands | commands/install-mcp.ts, install-hook.ts |
| 14 | MCP server setup | src/mcp/index.ts |
| 15 | MCP search tools | src/mcp/tools/search-code,get-function,get-class,get-file-structure,get-repo-structure |
| 16 | MCP traversal tools | src/mcp/tools/get-callers,get-callees,get-dependencies,get-dependents,reindex |
| 17 | Staleness middleware | src/mcp/staleness-check.ts |
| 18 | Query CLI | src/cli/commands/query.ts |
| 19 | Visualization | src/visualize/ |
| 20 | Microservice fixtures | tests/fixtures/microservices/ |
| 21 | Integration tests | tests/integration/, tests/mcp/tools.test.ts |
| 22 | Final wiring | Build verification, test pass |
| 23 | E2E smoke test | tests/e2e/setup.test.ts |
