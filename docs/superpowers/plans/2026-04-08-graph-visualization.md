# Graph Visualization Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken `--file` / `--function` CLI flags for `code-graph-rag visualize`, and overhaul the in-browser graph view with sidebar controls, click-to-expand interaction, edge-type coloring, degree-based node sizing, and a tuned `forceAtlas2Based` physics layout that stops nodes from overlapping.

**Architecture:** Hybrid filtering — server handles structural filters (which subset to load) via new Cypher query builders in `src/visualize/queries.ts`; the browser handles view filters (toggle node/edge types, search-highlight) entirely client-side via a `viewState` object that drives a single `applyViewFilters()` pass over the loaded `vis.DataSet`. Click-to-expand fetches additional neighborhoods on demand and merges them into the loaded set.

**Tech Stack:** TypeScript, Node.js HTTP server, Neo4j (via `neo4j-driver`), vis-network (browser-side, loaded via CDN), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-04-08-graph-visualization-design.md`

---

## Phase 1: Server-side Cypher builders + dispatch

This phase fixes the bug that started the work: `--file` and `--function` actually doing something. By the end of Phase 1 the flags work end-to-end (verified by HTTP integration tests). The browser is still the old UI — we restructure it in Phase 2.

### Task 1: Create `src/visualize/queries.ts` skeleton

**Files:**
- Create: `src/visualize/queries.ts`
- Test: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Create the skeleton file**

```ts
// src/visualize/queries.ts

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

export const INITIAL_LIMIT = 500;
export const EXPAND_FILE_LIMIT = 100;
export const EXPAND_FUNCTION_LIMIT = 50;
export const SEARCH_LIMIT = 25;
```

- [ ] **Step 2: Create the test file with one smoke test**

```ts
// tests/visualize/queries.test.ts
import { describe, it, expect } from "vitest";
import { INITIAL_LIMIT, EXPAND_FILE_LIMIT, EXPAND_FUNCTION_LIMIT, SEARCH_LIMIT } from "../../src/visualize/queries.js";

describe("visualize/queries — limits", () => {
  it("exports limit constants", () => {
    expect(INITIAL_LIMIT).toBe(500);
    expect(EXPAND_FILE_LIMIT).toBe(100);
    expect(EXPAND_FUNCTION_LIMIT).toBe(50);
    expect(SEARCH_LIMIT).toBe(25);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 1 passed.

- [ ] **Step 4: Type-check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add queries.ts skeleton with limit constants"
```

---

### Task 2: `repoOverview` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { repoOverview } from "../../src/visualize/queries.js";

describe("repoOverview", () => {
  it("returns repo + files + IMPORTS edges, no symbols", () => {
    const { cypher, params } = repoOverview();
    expect(cypher).toContain("MATCH (r:Repository)");
    expect(cypher).toContain(":CONTAINS_FILE");
    expect(cypher).toContain(":IMPORTS");
    expect(cypher).not.toContain(":Function");
    expect(cypher).not.toContain(":Class");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ repoName: null, limit: 500 });
  });

  it("filters by repo name when provided", () => {
    const { cypher, params } = repoOverview("my-service");
    expect(cypher).toContain("$repoName IS NULL OR r.name = $repoName");
    expect(params).toEqual({ repoName: "my-service", limit: 500 });
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL with "repoOverview is not a function".

- [ ] **Step 3: Implement `repoOverview`**

Append to `src/visualize/queries.ts`:

```ts
export function repoOverview(repoName?: string): CypherQuery {
  return {
    cypher: `
      MATCH (r:Repository)
      WHERE $repoName IS NULL OR r.name = $repoName
      MATCH (r)-[contains:CONTAINS_FILE]->(f:File)
      OPTIONAL MATCH (f)-[imp:IMPORTS]->(other:File)
      WHERE (r)-[:CONTAINS_FILE]->(other)
      RETURN r, contains, f, imp, other
      LIMIT $limit
    `,
    params: { repoName: repoName ?? null, limit: INITIAL_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Type-check and commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add repoOverview query builder"
```

---

### Task 3: `filterByFile` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { filterByFile } from "../../src/visualize/queries.js";

describe("filterByFile", () => {
  it("returns the file + symbols + class methods", () => {
    const { cypher, params } = filterByFile("src/api.ts");
    expect(cypher).toContain("MATCH (f:File)");
    expect(cypher).toContain("f.relativePath = $relativePath");
    expect(cypher).toContain(":CONTAINS");
    expect(cypher).toContain(":HAS_METHOD");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ relativePath: "src/api.ts", limit: 500 });
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL with "filterByFile is not a function".

- [ ] **Step 3: Implement `filterByFile`**

Append to `src/visualize/queries.ts`:

```ts
export function filterByFile(relativePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {relativePath: $relativePath})
      OPTIONAL MATCH (f)-[contains:CONTAINS]->(sym)
      WHERE sym:Function OR sym:Class
      OPTIONAL MATCH (sym)-[hasMethod:HAS_METHOD]->(method:Function)
      RETURN f, contains, sym, hasMethod, method
      LIMIT $limit
    `,
    params: { relativePath, limit: INITIAL_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add filterByFile query builder"
```

---

### Task 4: `filterByFunction` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { filterByFunction } from "../../src/visualize/queries.js";

describe("filterByFunction", () => {
  it("returns matching functions + containing files + 1-hop CALLS", () => {
    const { cypher, params } = filterByFunction("handleRequest");
    expect(cypher).toContain("MATCH (fn:Function {name: $name})");
    expect(cypher).toContain(":CONTAINS"); // file -> function
    expect(cypher).toContain(":CALLS");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ name: "handleRequest", limit: 500 });
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `filterByFunction`**

Append to `src/visualize/queries.ts`:

```ts
export function filterByFunction(name: string): CypherQuery {
  return {
    cypher: `
      MATCH (fn:Function {name: $name})
      OPTIONAL MATCH (file:File)-[contains:CONTAINS]->(fn)
      OPTIONAL MATCH (fn)-[outCall:CALLS]->(callee:Function)
      OPTIONAL MATCH (caller:Function)-[inCall:CALLS]->(fn)
      RETURN fn, file, contains, outCall, callee, inCall, caller
      LIMIT $limit
    `,
    params: { name, limit: INITIAL_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add filterByFunction query builder"
```

---

### Task 5: `expandFile` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { expandFile, EXPAND_FILE_LIMIT } from "../../src/visualize/queries.js";

describe("expandFile", () => {
  it("returns symbols and class methods for a given absolute file path", () => {
    const { cypher, params } = expandFile("/abs/repo/src/api.ts");
    expect(cypher).toContain("MATCH (f:File {path: $filePath})");
    expect(cypher).toContain(":CONTAINS");
    expect(cypher).toContain(":HAS_METHOD");
    expect(params).toEqual({ filePath: "/abs/repo/src/api.ts", limit: EXPAND_FILE_LIMIT });
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `expandFile`**

Append to `src/visualize/queries.ts`:

```ts
export function expandFile(filePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MATCH (f)-[contains:CONTAINS]->(sym)
      WHERE sym:Function OR sym:Class
      OPTIONAL MATCH (sym)-[hasMethod:HAS_METHOD]->(method:Function)
      RETURN f, contains, sym, hasMethod, method
      LIMIT $limit
    `,
    params: { filePath, limit: EXPAND_FILE_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add expandFile query builder"
```

---

### Task 6: `expandFunction` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { expandFunction, EXPAND_FUNCTION_LIMIT } from "../../src/visualize/queries.js";

describe("expandFunction", () => {
  it("returns 1-hop callers and callees, no further depth", () => {
    const { cypher, params } = expandFunction("handleRequest", "/abs/repo/src/api.ts");
    expect(cypher).toContain("MATCH (fn:Function {name: $name, filePath: $filePath})");
    expect(cypher).toContain("(fn)-[outCall:CALLS]->(callee:Function)");
    expect(cypher).toContain("(caller:Function)-[inCall:CALLS]->(fn)");
    // No 2-hop pattern like *2 or chained CALLS
    expect(cypher).not.toMatch(/CALLS\*[0-9]/);
    expect(params).toEqual({
      name: "handleRequest",
      filePath: "/abs/repo/src/api.ts",
      limit: EXPAND_FUNCTION_LIMIT,
    });
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `expandFunction`**

Append to `src/visualize/queries.ts`:

```ts
export function expandFunction(name: string, filePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (fn:Function {name: $name, filePath: $filePath})
      OPTIONAL MATCH (fn)-[outCall:CALLS]->(callee:Function)
      OPTIONAL MATCH (caller:Function)-[inCall:CALLS]->(fn)
      RETURN fn, outCall, callee, inCall, caller
      LIMIT $limit
    `,
    params: { name, filePath, limit: EXPAND_FUNCTION_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add expandFunction query builder"
```

---

### Task 7: `searchByName` builder

**Files:**
- Modify: `src/visualize/queries.ts`
- Modify: `tests/visualize/queries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/visualize/queries.test.ts`:

```ts
import { searchByName, SEARCH_LIMIT } from "../../src/visualize/queries.js";

describe("searchByName", () => {
  it("uses the code_search full-text index and respects limit", () => {
    const { cypher, params } = searchByName("handle");
    expect(cypher).toContain("CALL db.index.fulltext.queryNodes('code_search'");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ q: "handle*", limit: SEARCH_LIMIT });
  });

  it("appends '*' to the query to enable prefix matching", () => {
    const { params } = searchByName("foo");
    expect(params.q).toBe("foo*");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `searchByName`**

Append to `src/visualize/queries.ts`:

```ts
export function searchByName(prefix: string): CypherQuery {
  return {
    cypher: `
      CALL db.index.fulltext.queryNodes('code_search', $q) YIELD node, score
      WITH node, score
      WHERE node:Function OR node:Class
      RETURN node
      ORDER BY score DESC
      LIMIT $limit
    `,
    params: { q: `${prefix}*`, limit: SEARCH_LIMIT },
  };
}
```

- [ ] **Step 4: Run test, expect pass**

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/visualize/queries.ts tests/visualize/queries.test.ts
git commit -m "feat(visualize): add searchByName query builder using full-text index"
```

---

### Task 8: Server dispatcher — `/api/graph` with `file`/`function` branches

**Files:**
- Modify: `src/visualize/server.ts`

- [ ] **Step 1: Replace the inline Cypher in `handleRequest` with a dispatcher**

Edit `src/visualize/server.ts`. Replace the entire `if (url === "/api/graph") { ... }` block (currently at lines 28-91) with this:

```ts
import {
  repoOverview,
  filterByFile,
  filterByFunction,
  expandFile,
  expandFunction,
  searchByName,
  type CypherQuery,
} from "./queries.js";

// ... (rest of imports unchanged)

async function runCypher(driver: Driver, q: CypherQuery): Promise<{ nodes: object[]; edges: object[] }> {
  const session = driver.session();
  try {
    const result = await session.run(q.cypher, q.params, { timeout: 10000 });
    const nodes = new Map<string, object>();
    const edges: object[] = [];

    for (const record of result.records) {
      for (const key of record.keys) {
        const val = record.get(key);
        if (val && typeof val === "object" && "identity" in val && "labels" in val) {
          const id = val.identity.toString();
          if (!nodes.has(id)) {
            nodes.set(id, {
              id,
              label: val.properties.name || val.properties.relativePath || id,
              group: val.labels?.[0] ?? "Unknown",
              properties: val.properties,
            });
          }
        }
        if (val && typeof val === "object" && "type" in val && "start" in val && "end" in val) {
          edges.push({
            from: val.start.toString(),
            to: val.end.toString(),
            label: val.type,
          });
        }
      }
    }

    return { nodes: Array.from(nodes.values()), edges };
  } finally {
    await session.close();
  }
}

function pickInitialQuery(opts: VisualizationOptions, urlParams: URLSearchParams): CypherQuery {
  // URL params take precedence over CLI flags so the browser can re-query without restart
  const file = urlParams.get("file") ?? opts.filter.file;
  const fn = urlParams.get("function") ?? opts.filter.function;
  const repo = urlParams.get("repo") ?? opts.filter.repo;

  if (file) return filterByFile(file);
  if (fn) return filterByFunction(fn);
  return repoOverview(repo);
}
```

Then update the request handler dispatch:

```ts
async function handleRequest(
  res: ServerResponse,
  url: string,
  driver: Driver,
  opts: VisualizationOptions
): Promise<void> {
  const parsedUrl = new URL(url, "http://localhost");
  const pathname = parsedUrl.pathname;
  const params = parsedUrl.searchParams;

  if (pathname === "/api/graph") {
    try {
      const data = await runCypher(driver, pickInitialQuery(opts, params));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/graph error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // (static file serving stays unchanged below)
  // ... existing static file block
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Manually verify the URL parser handles the existing flags**

Run the unit tests (queries tests should still pass):

Run: `npm test -- tests/visualize/queries.test.ts`
Expected: 9 passed.

- [ ] **Step 4: Commit**

```bash
git add src/visualize/server.ts
git commit -m "feat(visualize): wire /api/graph to query builders, support file/function/repo via URL params and CLI"
```

---

### Task 9: `/api/expand` endpoint

**Files:**
- Modify: `src/visualize/server.ts`

- [ ] **Step 1: Add the expand handler**

Edit `src/visualize/server.ts`. After the `/api/graph` block in `handleRequest`, add:

```ts
  if (pathname === "/api/expand") {
    const type = params.get("type");
    try {
      let q: CypherQuery;
      if (type === "file") {
        const filePath = params.get("filePath");
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing filePath" }));
          return;
        }
        q = expandFile(filePath);
      } else if (type === "function") {
        const name = params.get("name");
        const filePath = params.get("filePath");
        if (!name || !filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing name or filePath" }));
          return;
        }
        q = expandFunction(name, filePath);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown expand type: ${type}` }));
        return;
      }

      const data = await runCypher(driver, q);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/expand error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/visualize/server.ts
git commit -m "feat(visualize): add /api/expand endpoint for click-to-expand"
```

---

### Task 10: `/api/search` endpoint

**Files:**
- Modify: `src/visualize/server.ts`

- [ ] **Step 1: Add the search handler**

Edit `src/visualize/server.ts`. After the `/api/expand` block in `handleRequest`, add:

```ts
  if (pathname === "/api/search") {
    const q = params.get("q");
    if (!q) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing q" }));
      return;
    }
    try {
      const data = await runCypher(driver, searchByName(q));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/search error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/visualize/server.ts
git commit -m "feat(visualize): add /api/search endpoint backed by code_search full-text index"
```

---

### Task 11: HTTP integration tests against Neo4j fixture

**Files:**
- Create: `tests/visualize/server.int.test.ts`

This test boots the server against the existing microservices fixture (used by `tests/integration/microservices.test.ts`) and asserts the endpoints return the expected shapes. It is gated by `INTEGRATION=1` like the existing integration test.

- [ ] **Step 1: Create the test file**

```ts
// tests/visualize/server.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { createConnection } from "../../src/db/connection.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository } from "../../src/indexer/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { startVisualizationServer } from "../../src/visualize/server.js";
import type { Server } from "node:http";

const INTEGRATION = !!process.env.INTEGRATION;
const PORT = 33334; // unique to avoid clashing with default 3333

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(`http://localhost:${PORT}${path}`);
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

describe.skipIf(!INTEGRATION)("visualize server endpoints", () => {
  let server: Server | undefined;

  beforeAll(async () => {
    const db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);

    // Index a fixture so the graph has known content
    await indexRepository(
      db,
      resolve("tests/fixtures/microservices/auth-service"),
      DEFAULT_CONFIG.index
    );
    await db.close();

    server = await startVisualizationServerForTest({
      neo4jConfig: {
        uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
        username: process.env.NEO4J_USERNAME ?? "neo4j",
        password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
        managed: false,
      },
      port: PORT,
      filter: {},
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("GET /api/graph returns repo overview by default", async () => {
    const { status, body } = await getJson("/api/graph");
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.nodes.some((n: any) => n.group === "Repository")).toBe(true);
    expect(body.nodes.some((n: any) => n.group === "File")).toBe(true);
    expect(body.nodes.every((n: any) => n.group !== "Function")).toBe(true);
  });

  it("GET /api/graph?file=... returns the file's symbols", async () => {
    // Find a known file from the fixture first
    const overview = await getJson("/api/graph");
    const file = overview.body.nodes.find(
      (n: any) => n.group === "File" && n.properties.relativePath
    );
    expect(file).toBeDefined();

    const { status, body } = await getJson(
      `/api/graph?file=${encodeURIComponent(file.properties.relativePath)}`
    );
    expect(status).toBe(200);
    expect(body.nodes.some((n: any) => n.group === "File")).toBe(true);
    // At least one symbol should appear (Function or Class)
    expect(
      body.nodes.some((n: any) => n.group === "Function" || n.group === "Class")
    ).toBe(true);
  });

  it("GET /api/graph?function=validateToken returns the function + neighbors", async () => {
    const { status, body } = await getJson("/api/graph?function=validateToken");
    expect(status).toBe(200);
    expect(body.nodes.some((n: any) => n.group === "Function" && n.label === "validateToken")).toBe(
      true
    );
  });

  it("GET /api/expand?type=file&filePath=... returns symbols only", async () => {
    const overview = await getJson("/api/graph");
    const file = overview.body.nodes.find(
      (n: any) => n.group === "File" && n.properties.path
    );
    expect(file).toBeDefined();

    const { status, body } = await getJson(
      `/api/expand?type=file&filePath=${encodeURIComponent(file.properties.path)}`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("GET /api/expand?type=garbage returns 400", async () => {
    const { status, body } = await getJson("/api/expand?type=garbage");
    expect(status).toBe(400);
    expect(body.error).toContain("unknown expand type");
  });

  it("GET /api/search?q=valid returns matching nodes", async () => {
    const { status, body } = await getJson("/api/search?q=valid");
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("GET /api/graph?file=does-not-exist returns 200 with empty nodes", async () => {
    const { status, body } = await getJson("/api/graph?file=does-not-exist.ts");
    expect(status).toBe(200);
    expect(body.nodes).toEqual([]);
  });
});
```

- [ ] **Step 2: Add `startVisualizationServerForTest` helper**

The current `startVisualizationServer` calls `process.exit(1)` on Neo4j connection failure and opens a browser — both bad for tests. Add a test-only export that returns the `Server` instance and skips browser-opening.

Edit `src/visualize/server.ts`. After `startVisualizationServer`, add:

```ts
/**
 * Test-only variant of startVisualizationServer:
 *   - returns the Server instance so tests can close it
 *   - does not call openBrowser
 *   - throws (does not process.exit) on connection failure
 */
export async function startVisualizationServerForTest(
  opts: VisualizationOptions
): Promise<import("node:http").Server> {
  const driver = neo4j.driver(
    opts.neo4jConfig.uri,
    neo4j.auth.basic(opts.neo4jConfig.username, opts.neo4jConfig.password),
    { connectionTimeout: 5000 }
  );

  const pingSession = driver.session();
  try {
    await pingSession.run("RETURN 1", {}, { timeout: 5000 });
  } finally {
    await pingSession.close();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    handleRequest(res, url, driver, opts).catch((err) => {
      console.error("[viz-test] unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve(server));
  });
}
```

- [ ] **Step 3: Run integration test (requires Neo4j running)**

Run: `INTEGRATION=1 npm test -- tests/visualize/server.int.test.ts`
Expected: 7 passed.

If Neo4j isn't running locally, run `code-graph-rag init` first or `docker compose up -d`.

- [ ] **Step 4: Run the full test suite to make sure nothing else broke**

Run: `npm test`
Expected: all unit tests pass; integration tests skipped without `INTEGRATION=1`.

- [ ] **Step 5: Commit**

```bash
git add tests/visualize/server.int.test.ts src/visualize/server.ts
git commit -m "test(visualize): integration tests for /api/graph, /api/expand, /api/search

Verifies the previously broken --file and --function flags now return the
expected node sets, and the new expand/search endpoints behave correctly."
```

---

## Phase 2: Frontend state restructure (no behavior change)

This phase reshapes `graph.js` so it has the `viewState` / `loadedSet` two-layer model the spec calls for, but the user-visible behavior is unchanged. We make this a separate phase to keep the diff for Phase 3 (sidebar) focused only on adding new things.

### Task 12: Restructure `graph.js` into named sections

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Replace `graph.js` with the restructured version**

Replace the entire contents of `src/visualize/public/graph.js` with:

```js
// src/visualize/public/graph.js
//
// Sections:
//   STATE   — viewState + loadedSet
//   API     — fetch wrappers
//   MERGE   — server response → loadedSet
//   RENDER  — vis.Network init + applyViewFilters
//   EVENTS  — DOM/network event handlers
//   BOOT    — entry point

// === STATE ===
const GROUP_COLORS = {
  Repository: { background: "#1f6feb", border: "#388bfd" },
  File: { background: "#1a7f37", border: "#2ea043" },
  Class: { background: "#8957e5", border: "#a371f7" },
  Function: { background: "#da3633", border: "#f85149" },
};

const viewState = {
  search: "",
  visibleNodeTypes: new Set(["Repository", "File", "Class", "Function"]),
  visibleEdgeTypes: new Set([
    "CONTAINS_FILE",
    "CONTAINS",
    "HAS_METHOD",
    "IMPORTS",
    "CALLS",
  ]),
};

const loadedSet = {
  nodes: new vis.DataSet(),
  edges: new vis.DataSet(),
};

let network = null;
let edgeIdCounter = 0;

// === API ===
function parseUrlFilters() {
  const p = new URLSearchParams(window.location.search);
  const out = {};
  for (const k of ["repo", "file", "function"]) {
    const v = p.get(k);
    if (v) out[k] = v;
  }
  return out;
}

async function fetchGraph(filters) {
  const qs = new URLSearchParams(filters).toString();
  const url = qs ? `/api/graph?${qs}` : "/api/graph";
  const resp = await fetch(url);
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error ?? ""; } catch {}
    throw new Error(`fetchGraph failed: ${detail || resp.statusText}`);
  }
  return resp.json();
}

// === MERGE ===
function mergeIntoLoaded({ nodes, edges }) {
  for (const n of nodes) {
    if (!loadedSet.nodes.get(n.id)) {
      loadedSet.nodes.add({
        id: n.id,
        label: n.label,
        color: GROUP_COLORS[n.group] ?? { background: "#6e7681", border: "#8b949e" },
        title: n.group,
        font: { color: "#c9d1d9" },
        _properties: n.properties,
        _group: n.group,
      });
    }
  }
  for (const e of edges) {
    loadedSet.edges.add({
      id: edgeIdCounter++,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: "#30363d", highlight: "#58a6ff" },
      font: { color: "#8b949e", size: 10 },
      _type: e.label,
    });
  }
}

// === RENDER ===
function initNetwork() {
  const container = document.getElementById("graph");
  network = new vis.Network(
    container,
    { nodes: loadedSet.nodes, edges: loadedSet.edges },
    {
      physics: { stabilization: { iterations: 100 } },
      edges: { smooth: { type: "continuous" } },
      interaction: { hover: true },
    }
  );

  network.on("click", onNodeClick);
}

function applyViewFilters() {
  // Phase 2 placeholder — full implementation arrives in Phase 3.
  // For now, behavior matches the old code: everything is visible.
}

// === EVENTS ===
function onNodeClick(params) {
  if (params.nodes.length > 0) {
    const node = loadedSet.nodes.get(params.nodes[0]);
    document.getElementById("panel-hint").style.display = "none";
    const content = document.getElementById("panel-content");
    content.style.display = "block";
    content.textContent = `[${node._group}] ${node.label}\n\n${JSON.stringify(node._properties, null, 2)}`;
  }
}

// === BOOT ===
async function boot() {
  const status = document.getElementById("status");
  status.textContent = "Fetching graph data...";

  let data;
  try {
    data = await fetchGraph(parseUrlFilters());
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  if (data.nodes.length === 0) {
    status.textContent = "No graph data — run `code-graph-rag index` first, then refresh.";
    return;
  }

  initNetwork();
  mergeIntoLoaded(data);
  applyViewFilters();
  status.textContent = `${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges`;
}

boot().catch(console.error);
```

- [ ] **Step 2: Build and run a manual smoke test**

Run: `npm run build`
Expected: clean build.

Then start Neo4j (if not running) and the visualizer:
```bash
docker compose up -d
node bin/code-graph-rag.js visualize
```
Expected: browser opens, shows the same graph as before, clicking a node updates the right-side detail panel.

- [ ] **Step 3: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "refactor(visualize): restructure graph.js into viewState/loadedSet sections (no behavior change)"
```

---

## Phase 3: Sidebar UI + view filters

### Task 13: Add sidebar markup and CSS to `index.html`

**Files:**
- Modify: `src/visualize/public/index.html`

- [ ] **Step 1: Replace `index.html` with sidebar version**

Replace the entire contents with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Graph RAG — Visualization</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; height: 100vh; display: flex; flex-direction: column; }
    #header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; font-size: 14px; }
    #header h1 { font-size: 16px; color: #58a6ff; }
    #main { display: flex; flex: 1; overflow: hidden; }

    #sidebar { width: 240px; background: #161b22; border-right: 1px solid #30363d; padding: 16px; overflow-y: auto; font-size: 12px; }
    #sidebar h3 { font-size: 11px; color: #58a6ff; margin-bottom: 6px; margin-top: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
    #sidebar h3:first-child { margin-top: 0; }
    #sidebar input[type="text"] {
      width: 100%; padding: 6px 8px; background: #0d1117; color: #c9d1d9;
      border: 1px solid #30363d; border-radius: 4px; font-family: inherit; font-size: 12px;
    }
    #sidebar label { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; }
    #sidebar label input { cursor: pointer; }
    #sidebar .legend-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
    #sidebar .legend-swatch { width: 10px; height: 10px; border-radius: 50%; }
    #sidebar button {
      width: 100%; padding: 6px 8px; margin-top: 4px;
      background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px;
      font-family: inherit; font-size: 12px; cursor: pointer;
    }
    #sidebar button:hover { background: #30363d; }
    #sidebar #search-result { color: #8b949e; font-size: 11px; margin-top: 4px; min-height: 14px; }
    #sidebar #loaded-counter { color: #8b949e; margin-top: 12px; font-size: 11px; }

    #graph { flex: 1; }
    #panel { width: 300px; background: #161b22; border-left: 1px solid #30363d; padding: 16px; overflow-y: auto; font-size: 12px; }
    #panel h2 { font-size: 14px; color: #58a6ff; margin-bottom: 8px; }
    #panel pre { white-space: pre-wrap; word-break: break-all; color: #8b949e; }
    #status { color: #8b949e; }
  </style>
</head>
<body>
  <div id="header">
    <h1>Code Graph RAG</h1>
    <span id="status">Loading graph...</span>
  </div>
  <div id="main">
    <div id="sidebar">
      <h3>Search</h3>
      <input id="search-input" type="text" placeholder="function or class name…" autocomplete="off">
      <div id="search-result"></div>

      <h3>Show node types</h3>
      <label><input type="checkbox" data-node-type="Repository" checked> Repository</label>
      <label><input type="checkbox" data-node-type="File" checked> File</label>
      <label><input type="checkbox" data-node-type="Class" checked> Class</label>
      <label><input type="checkbox" data-node-type="Function" checked> Function</label>

      <h3>Show edge types</h3>
      <label><input type="checkbox" data-edge-type="CONTAINS_FILE" checked> CONTAINS_FILE</label>
      <label><input type="checkbox" data-edge-type="CONTAINS" checked> CONTAINS</label>
      <label><input type="checkbox" data-edge-type="HAS_METHOD" checked> HAS_METHOD</label>
      <label><input type="checkbox" data-edge-type="IMPORTS" checked> IMPORTS</label>
      <label><input type="checkbox" data-edge-type="CALLS" checked> CALLS</label>
      <label><input type="checkbox" data-edge-type="IMPORTS_SYMBOL"> IMPORTS_SYMBOL</label>

      <h3>Legend</h3>
      <div class="legend-row"><span class="legend-swatch" style="background:#1f6feb"></span> Repository</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#1a7f37"></span> File</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#8957e5"></span> Class</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#da3633"></span> Function</div>

      <button id="freeze-btn">Freeze layout</button>
      <button id="reset-view-btn">Reset view filters</button>
      <button id="reset-all-btn">Reset everything</button>
      <div id="loaded-counter">Loaded: 0 nodes, 0 edges</div>
    </div>

    <div id="graph"></div>
    <div id="panel">
      <h2>Details</h2>
      <p id="panel-hint" style="color:#8b949e">Click a node to see details</p>
      <pre id="panel-content" style="display:none"></pre>
    </div>
  </div>
  <script src="graph.js"></script>
</body>
</html>
```

- [ ] **Step 2: Build and visually verify the sidebar exists**

Run: `npm run build`
Expected: clean.

Run: `node bin/code-graph-rag.js visualize`
Expected: browser opens. Sidebar shows on the left with all controls (none of them are wired yet — that's Task 14). Graph still renders.

- [ ] **Step 3: Commit**

```bash
git add src/visualize/public/index.html
git commit -m "feat(visualize): add sidebar markup with search, type toggles, legend, buttons"
```

---

### Task 14: Wire `applyViewFilters` and node-type toggles

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Replace the placeholder `applyViewFilters` with the real implementation**

Edit `src/visualize/public/graph.js`. Replace the placeholder `applyViewFilters` function with:

```js
function applyViewFilters() {
  const nodeUpdates = [];
  const edgeUpdates = [];

  loadedSet.nodes.forEach((n) => {
    const hidden = !viewState.visibleNodeTypes.has(n._group);
    if (n.hidden !== hidden) {
      nodeUpdates.push({ id: n.id, hidden });
    }
  });

  loadedSet.edges.forEach((e) => {
    const typeHidden = !viewState.visibleEdgeTypes.has(e._type);
    const fromNode = loadedSet.nodes.get(e.from);
    const toNode = loadedSet.nodes.get(e.to);
    const endpointHidden =
      (fromNode && fromNode.hidden) || (toNode && toNode.hidden);
    const hidden = typeHidden || !!endpointHidden;
    if (e.hidden !== hidden) {
      edgeUpdates.push({ id: e.id, hidden });
    }
  });

  if (nodeUpdates.length) loadedSet.nodes.update(nodeUpdates);
  if (edgeUpdates.length) loadedSet.edges.update(edgeUpdates);
  updateLoadedCounter();
}

function updateLoadedCounter() {
  const visibleNodes = loadedSet.nodes.get({ filter: (n) => !n.hidden }).length;
  const visibleEdges = loadedSet.edges.get({ filter: (e) => !e.hidden }).length;
  const el = document.getElementById("loaded-counter");
  if (el) {
    el.textContent = `Loaded: ${loadedSet.nodes.length} nodes, ${loadedSet.edges.length} edges (${visibleNodes}/${visibleEdges} visible)`;
  }
}
```

- [ ] **Step 2: Add a `bindSidebarEvents` function**

Add at the bottom of the EVENTS section:

```js
function bindSidebarEvents() {
  document.querySelectorAll('input[data-node-type]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target.dataset.nodeType;
      if (e.target.checked) {
        viewState.visibleNodeTypes.add(t);
      } else {
        viewState.visibleNodeTypes.delete(t);
      }
      applyViewFilters();
    });
  });

  document.querySelectorAll('input[data-edge-type]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const t = e.target.dataset.edgeType;
      if (e.target.checked) {
        viewState.visibleEdgeTypes.add(t);
      } else {
        viewState.visibleEdgeTypes.delete(t);
      }
      applyViewFilters();
    });
  });
}
```

- [ ] **Step 3: Call `bindSidebarEvents()` from `boot()`**

In `boot()`, after `initNetwork()` and before the fetch:

```js
  initNetwork();
  bindSidebarEvents();
```

- [ ] **Step 4: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: toggling "Function" hides all function nodes immediately, no network requests. Toggling "CALLS" hides call edges. Loaded counter updates.

- [ ] **Step 5: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): wire node/edge type toggles to applyViewFilters"
```

---

### Task 15: Wire search box (client-side highlight + server fallback)

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add `fetchSearch` to the API section**

```js
async function fetchSearch(q) {
  const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!resp.ok) throw new Error("search failed");
  return resp.json();
}
```

- [ ] **Step 2: Extend `applyViewFilters` to apply the search highlight**

Replace `applyViewFilters` again with this version:

```js
function applyViewFilters() {
  const nodeUpdates = [];
  const edgeUpdates = [];
  const q = viewState.search.trim().toLowerCase();

  loadedSet.nodes.forEach((n) => {
    const typeHidden = !viewState.visibleNodeTypes.has(n._group);
    const matches = !q || (n.label && n.label.toLowerCase().includes(q));
    const hidden = typeHidden;
    const borderWidth = q && matches ? 4 : 1;
    const update = {};
    if (n.hidden !== hidden) update.hidden = hidden;
    if ((n.borderWidth ?? 1) !== borderWidth) update.borderWidth = borderWidth;
    if (Object.keys(update).length) {
      update.id = n.id;
      nodeUpdates.push(update);
    }
  });

  loadedSet.edges.forEach((e) => {
    const typeHidden = !viewState.visibleEdgeTypes.has(e._type);
    const fromNode = loadedSet.nodes.get(e.from);
    const toNode = loadedSet.nodes.get(e.to);
    const endpointHidden =
      (fromNode && fromNode.hidden) || (toNode && toNode.hidden);
    const hidden = typeHidden || !!endpointHidden;
    if (e.hidden !== hidden) {
      edgeUpdates.push({ id: e.id, hidden });
    }
  });

  if (nodeUpdates.length) loadedSet.nodes.update(nodeUpdates);
  if (edgeUpdates.length) loadedSet.edges.update(edgeUpdates);
  updateLoadedCounter();
}
```

- [ ] **Step 3: Add search input handler in `bindSidebarEvents`**

Inside `bindSidebarEvents`, append:

```js
  let searchTimer = null;
  const searchInput = document.getElementById("search-input");
  const searchResult = document.getElementById("search-result");
  searchInput.addEventListener("input", (e) => {
    viewState.search = e.target.value;
    applyViewFilters();

    // Count local matches
    const q = viewState.search.trim().toLowerCase();
    if (!q) {
      searchResult.textContent = "";
      return;
    }
    const localHits = loadedSet.nodes.get({
      filter: (n) => n.label && n.label.toLowerCase().includes(q),
    }).length;
    searchResult.textContent = `${localHits} local match${localHits === 1 ? "" : "es"}`;

    // Debounced server fallback for "load missing matches"
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (viewState.search.trim().length < 2) return;
      try {
        const data = await fetchSearch(viewState.search.trim());
        if (data.nodes && data.nodes.length > 0) {
          mergeIntoLoaded(data);
          applyViewFilters();
          searchResult.textContent = `${localHits} local + ${data.nodes.length} server match${data.nodes.length === 1 ? "" : "es"}`;
        } else if (localHits === 0) {
          searchResult.textContent = "No matches";
        }
      } catch {
        // Quietly ignore search failures — user is still typing
      }
    }, 350);
  });
```

- [ ] **Step 4: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: typing in the search box highlights matching nodes (thicker border) and shows the count below. After 350ms with no input, server search runs and merges any new matches.

- [ ] **Step 5: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): wire search box with local highlight + debounced server fallback"
```

---

### Task 16: Reset buttons + freeze layout

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add reset and freeze handlers**

In `bindSidebarEvents`, append:

```js
  document.getElementById("reset-view-btn").addEventListener("click", () => {
    viewState.search = "";
    viewState.visibleNodeTypes = new Set(["Repository", "File", "Class", "Function"]);
    viewState.visibleEdgeTypes = new Set([
      "CONTAINS_FILE", "CONTAINS", "HAS_METHOD", "IMPORTS", "CALLS",
    ]);
    document.getElementById("search-input").value = "";
    document.getElementById("search-result").textContent = "";
    document.querySelectorAll('input[data-node-type]').forEach((i) => { i.checked = true; });
    document.querySelectorAll('input[data-edge-type]').forEach((i) => {
      i.checked = i.dataset.edgeType !== "IMPORTS_SYMBOL";
    });
    applyViewFilters();
  });

  document.getElementById("reset-all-btn").addEventListener("click", async () => {
    loadedSet.nodes.clear();
    loadedSet.edges.clear();
    edgeIdCounter = 0;
    try {
      const data = await fetchGraph(parseUrlFilters());
      mergeIntoLoaded(data);
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    }
  });

  let physicsEnabled = true;
  document.getElementById("freeze-btn").addEventListener("click", (e) => {
    physicsEnabled = !physicsEnabled;
    network.setOptions({ physics: { enabled: physicsEnabled } });
    e.target.textContent = physicsEnabled ? "Freeze layout" : "Unfreeze layout";
  });
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: Reset view filters re-enables all checkboxes and clears search. Reset everything reloads the initial graph. Freeze layout stops the physics simulation.

- [ ] **Step 3: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): add reset view, reset everything, and freeze layout buttons"
```

---

## Phase 4: Click-to-expand

### Task 17: Click-to-expand for File nodes

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add `pendingExpands` and `fetchExpand` to the API section**

After `fetchSearch`, add:

```js
async function fetchExpand(type, params) {
  const qs = new URLSearchParams({ type, ...params }).toString();
  const resp = await fetch(`/api/expand?${qs}`);
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error ?? ""; } catch {}
    throw new Error(`expand failed: ${detail || resp.statusText}`);
  }
  return resp.json();
}
```

In the STATE section, after `let edgeIdCounter = 0;`, add:

```js
const pendingExpands = new Set();
```

- [ ] **Step 2: Update `mergeIntoLoaded` to track `_expandedBy`**

Replace `mergeIntoLoaded` with this version:

```js
function mergeIntoLoaded({ nodes, edges }, expandedFromId) {
  for (const n of nodes) {
    const existing = loadedSet.nodes.get(n.id);
    if (!existing) {
      loadedSet.nodes.add({
        id: n.id,
        label: n.label,
        color: GROUP_COLORS[n.group] ?? { background: "#6e7681", border: "#8b949e" },
        title: n.group,
        font: { color: "#c9d1d9" },
        _properties: n.properties,
        _group: n.group,
        _expanded: false,
        _expandedBy: expandedFromId ? new Set([expandedFromId]) : new Set(),
      });
    } else if (expandedFromId) {
      // Mark this node as also reachable from expandedFromId
      existing._expandedBy.add(expandedFromId);
    }
  }
  for (const e of edges) {
    loadedSet.edges.add({
      id: edgeIdCounter++,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: "#30363d", highlight: "#58a6ff" },
      font: { color: "#8b949e", size: 10 },
      _type: e.label,
    });
  }
}
```

- [ ] **Step 3: Update `onNodeClick` to expand or update detail panel**

Replace `onNodeClick` with:

```js
async function onNodeClick(params) {
  if (params.nodes.length === 0) return;
  const nodeId = params.nodes[0];
  const node = loadedSet.nodes.get(nodeId);

  // Always update the detail panel
  document.getElementById("panel-hint").style.display = "none";
  const content = document.getElementById("panel-content");
  content.style.display = "block";
  content.textContent = `[${node._group}] ${node.label}\n\n${JSON.stringify(node._properties, null, 2)}`;

  // Expand if not already expanded and not already in flight
  if (node._expanded || pendingExpands.has(nodeId)) return;

  if (node._group === "File") {
    pendingExpands.add(nodeId);
    try {
      const data = await fetchExpand("file", { filePath: node._properties.path });
      mergeIntoLoaded(data, nodeId);
      // Mark file as expanded
      loadedSet.nodes.update({ id: nodeId, _expanded: true });
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    } finally {
      pendingExpands.delete(nodeId);
    }
  } else if (node._group === "Function") {
    pendingExpands.add(nodeId);
    try {
      const data = await fetchExpand("function", {
        name: node._properties.name,
        filePath: node._properties.filePath,
      });
      mergeIntoLoaded(data, nodeId);
      loadedSet.nodes.update({ id: nodeId, _expanded: true });
      applyViewFilters();
    } catch (err) {
      document.getElementById("status").textContent = err.message;
    } finally {
      pendingExpands.delete(nodeId);
    }
  }
  // Repository and Class clicks: detail panel only, no expand.
}
```

- [ ] **Step 4: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: clicking a File node loads its functions/classes after a brief delay; they appear connected by green CONTAINS edges. Clicking again on the same file does nothing (no flicker, no extra fetch). Clicking a Function loads its callers/callees.

- [ ] **Step 5: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): click-to-expand for File and Function nodes with race-guard"
```

---

### Task 18: Double-click collapse with `_expandedBy` bookkeeping

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add `onNodeDoubleClick` handler**

Add to the EVENTS section:

```js
function onNodeDoubleClick(params) {
  if (params.nodes.length === 0) return;
  const nodeId = params.nodes[0];
  const node = loadedSet.nodes.get(nodeId);
  if (!node || !node._expanded) return;

  // Find every node that was loaded *because of* nodeId
  const candidatesToRemove = loadedSet.nodes.get({
    filter: (n) => n._expandedBy && n._expandedBy.has(nodeId),
  });

  const removeIds = [];
  for (const cand of candidatesToRemove) {
    cand._expandedBy.delete(nodeId);
    if (cand._expandedBy.size === 0) {
      removeIds.push(cand.id);
    }
  }

  if (removeIds.length > 0) {
    // Remove edges touching removed nodes
    const removeIdsSet = new Set(removeIds);
    const edgeIds = loadedSet.edges.get({
      filter: (e) => removeIdsSet.has(e.from) || removeIdsSet.has(e.to),
      fields: ["id"],
    }).map((e) => e.id);

    loadedSet.edges.remove(edgeIds);
    loadedSet.nodes.remove(removeIds);
  }

  loadedSet.nodes.update({ id: nodeId, _expanded: false });
  applyViewFilters();
}
```

- [ ] **Step 2: Wire it up in `initNetwork`**

In `initNetwork`, after `network.on("click", onNodeClick);`, add:

```js
  network.on("doubleClick", onNodeDoubleClick);
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: expand a file (single-click), then double-click that same file. Its functions disappear. Try expanding two functions that share a callee, then double-click one — the shared callee should remain because the other expansion still references it.

- [ ] **Step 4: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): double-click collapse with shared-neighbor preservation"
```

---

## Phase 5: Visual / physics tuning

### Task 19: Apply `forceAtlas2Based` physics

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Replace the physics options in `initNetwork`**

In `initNetwork`, replace the `vis.Network` options object with:

```js
  network = new vis.Network(
    container,
    { nodes: loadedSet.nodes, edges: loadedSet.edges },
    {
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 150,
          springConstant: 0.08,
          damping: 0.4,
          avoidOverlap: 0.5,
        },
        stabilization: { iterations: 250, updateInterval: 25 },
        minVelocity: 0.5,
      },
      edges: {
        smooth: { type: "continuous", roundness: 0.2 },
        font: { size: 0, strokeWidth: 0 },
        arrows: { to: { scaleFactor: 0.6 } },
      },
      interaction: { hover: true, hoverConnectedEdges: true },
    }
  );
```

- [ ] **Step 2: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: nodes spread out more, no two nodes drawn on top of each other, layout settles within ~3 seconds. Edge labels are not shown by default (they appear on hover thanks to `hoverConnectedEdges`).

- [ ] **Step 3: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): switch to forceAtlas2Based physics with avoidOverlap"
```

---

### Task 20: Edge styling by type

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add `EDGE_STYLES` to the STATE section**

After `GROUP_COLORS`, add:

```js
const EDGE_STYLES = {
  CONTAINS_FILE:  { color: "#1f6feb", width: 1 },
  CONTAINS:       { color: "#1a7f37", width: 1 },
  HAS_METHOD:     { color: "#8957e5", width: 1 },
  IMPORTS:        { color: "#d29922", width: 1.5 },
  CALLS:          { color: "#da3633", width: 1 },
  IMPORTS_SYMBOL: { color: "#6e7681", width: 1, dashes: true },
};
```

- [ ] **Step 2: Use `EDGE_STYLES` in `mergeIntoLoaded`**

Replace the edge-add block in `mergeIntoLoaded` with:

```js
  for (const e of edges) {
    const style = EDGE_STYLES[e.label] ?? { color: "#30363d", width: 1 };
    loadedSet.edges.add({
      id: edgeIdCounter++,
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: "to",
      color: { color: style.color, highlight: "#58a6ff" },
      width: style.width,
      dashes: style.dashes ?? false,
      font: { color: "#8b949e", size: 10 },
      _type: e.label,
    });
  }
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: edges are now color-coded by type. IMPORTS edges are amber and slightly thicker. IMPORTS_SYMBOL edges are dashed gray (and hidden by default per the sidebar).

- [ ] **Step 4: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): color edges by relationship type"
```

---

### Task 21: Node sizing by degree

**Files:**
- Modify: `src/visualize/public/graph.js`

- [ ] **Step 1: Add `degreeToSize` and `recomputeNodeSizes`**

In the RENDER section, after `applyViewFilters`, add:

```js
function degreeToSize(degree) {
  return Math.min(35, 12 + Math.sqrt(degree) * 4);
}

function recomputeNodeSizes() {
  const degree = new Map();
  loadedSet.edges.forEach((e) => {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  });

  const updates = [];
  loadedSet.nodes.forEach((n) => {
    const newSize = degreeToSize(degree.get(n.id) ?? 0);
    if (n.size !== newSize) {
      updates.push({ id: n.id, size: newSize });
    }
  });
  if (updates.length) loadedSet.nodes.update(updates);
}
```

- [ ] **Step 2: Call `recomputeNodeSizes` after every merge**

In `boot()`, after `mergeIntoLoaded(data);`, add:

```js
    recomputeNodeSizes();
```

In `onNodeClick`, after each `mergeIntoLoaded(data, nodeId);` call (there are two, one for File and one for Function), add:

```js
      recomputeNodeSizes();
```

In `onNodeDoubleClick`, after `loadedSet.nodes.remove(removeIds);`, add:

```js
    recomputeNodeSizes();
```

In the search input handler, after the `mergeIntoLoaded(data);` call, add:

```js
          recomputeNodeSizes();
```

In the "Reset everything" handler, after `mergeIntoLoaded(data);`, add:

```js
      recomputeNodeSizes();
```

- [ ] **Step 3: Build and verify**

Run: `npm run build && node bin/code-graph-rag.js visualize`
Expected: high-degree nodes (functions called many times, files imported by many others) are visibly larger than leaf nodes. Sizes update after expansion.

- [ ] **Step 4: Commit**

```bash
git add src/visualize/public/graph.js
git commit -m "feat(visualize): size nodes by edge degree (sqrt scale)"
```

---

## Phase 6: README fix + dogfood

### Task 22: Fix README schema table

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the schema table**

Edit `README.md`. Replace the relationships table at lines 151-159 with:

```markdown
**Relationships**

| Relationship | Meaning |
|---|---|
| `(Repository)-[:CONTAINS_FILE]->(File)` | Repo owns file |
| `(File)-[:CONTAINS]->(Function\|Class)` | File contains top-level definition |
| `(Class)-[:HAS_METHOD]->(Function)` | Class method |
| `(Function)-[:CALLS]->(Function)` | Call edge |
| `(File)-[:IMPORTS]->(File)` | Import edge |
| `(File)-[:IMPORTS_SYMBOL]->(Function\|Class)` | Symbol-level import |
```

- [ ] **Step 2: Verify the README renders correctly**

Run: `head -200 README.md | tail -60`
Expected: schema table reflects the updated relationships.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): correct schema table — :CONTAINS / :HAS_METHOD, not :DEFINES"
```

---

### Task 23: Dogfood walkthrough on this repo

**Files:** None (manual verification)

This task has no code — it is the final verification that all the pieces work together against a real codebase (this one).

- [ ] **Step 1: Build everything fresh**

```bash
npm run build
```
Expected: clean.

- [ ] **Step 2: Re-index this repo to make sure the graph is current**

```bash
node bin/code-graph-rag.js index
```
Expected: indexes ~30 files cleanly.

- [ ] **Step 3: Open the default visualization**

```bash
node bin/code-graph-rag.js visualize
```
Expected:
- Browser opens to localhost:3333.
- Sidebar visible on the left, detail panel on the right.
- Default view shows ~1 Repository node + ~30 File nodes connected by amber IMPORTS edges.
- No node-on-node overlap.
- Loaded counter says something like "Loaded: 30 nodes, ~50 edges (30/~50 visible)".

- [ ] **Step 4: Click `src/visualize/server.ts`**

Expected: its functions appear (red) connected by green CONTAINS edges. Detail panel on the right shows the file's properties.

- [ ] **Step 5: Click `handleRequest`**

Expected: callers and callees of `handleRequest` appear connected by red CALLS edges.

- [ ] **Step 6: Toggle off "Function" in the sidebar**

Expected: all function nodes hide instantly. No network request happens (verify by checking devtools Network tab).

- [ ] **Step 7: Toggle "Function" back on, type "neo4j" in the search box**

Expected: matching nodes get a thicker border. Search-result line shows local + server match counts.

- [ ] **Step 8: Click "Reset everything"**

Expected: graph reloads to the initial overview.

- [ ] **Step 9: Test the previously-broken CLI flags**

Stop the server (Ctrl+C). Then run:

```bash
node bin/code-graph-rag.js visualize --file src/visualize/server.ts
```
Expected: opens to a focused view with `server.ts` and its symbols.

Stop, then:

```bash
node bin/code-graph-rag.js visualize --function handleRequest
```
Expected: opens to a focused view with `handleRequest` and its callers/callees.

- [ ] **Step 10: Run the full test suite one more time**

```bash
npm test
INTEGRATION=1 npm test
```
Expected: all tests pass.

- [ ] **Step 11: No commit needed**

This is a verification task. If any step fails, fix the underlying issue and re-run from Step 1.

---

## Self-Review Notes

After writing this plan, I checked it against the spec:

- **Spec coverage:** Every section of the spec maps to at least one task.
  - Server queries → Tasks 1-7
  - Server dispatcher / endpoints → Tasks 8-10
  - HTTP integration tests → Task 11
  - Two-layer state model + restructure → Task 12
  - Sidebar markup → Task 13
  - View filters wiring → Task 14
  - Search → Task 15
  - Reset / freeze → Task 16
  - Click-to-expand → Task 17
  - Double-click collapse → Task 18
  - Physics tuning → Task 19
  - Edge styling → Task 20
  - Node sizing → Task 21
  - README schema fix → Task 22
  - Dogfood walkthrough → Task 23

- **Placeholder scan:** No "TBD", "TODO", "implement later", or vague handwaving in any task. Every code step has the actual code.

- **Type consistency:** Function names match across tasks (`mergeIntoLoaded`, `applyViewFilters`, `recomputeNodeSizes`, `fetchExpand`, `onNodeClick`, `onNodeDoubleClick`, `bindSidebarEvents`). The `_expandedBy: Set` model is consistent between Task 17 (where it's introduced) and Task 18 (where it's read for collapse).

- **One missing thing I noticed during review:** The spec calls for a `pendingExpands` race-condition guard. Task 17 introduces it. ✓
