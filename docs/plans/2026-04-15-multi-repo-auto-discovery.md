# Multi-repo auto-discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-detect microservice subrepos under a non-git "pure container" root so `rho-graph init`/`index` creates one `Repository` node per subrepo instead of one big node for the whole tree, with results cached in `.rho-graph.json` and refreshed on a TTL.

**Architecture:** New `discoverRepos` BFS walk finds dirs containing `.git/`, stops descending into found repos, caps depth, prunes `index.exclude` dirs. New `resolveRepos` helper sits in front of `init`/`index`: reads `.rho-graph.json`, re-walks if the cache is stale (> `discovery.ttlHours`), reconciles and writes back, drops removed subrepos from the graph. Callers switch between `indexRepository` (single-repo) and `indexWorkspace` (multi-repo) based on what `resolveRepos` returns. A new `rho-graph discover` command forces a walk.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), vitest, commander, Neo4j. No new dependencies.

**Design reference:** `docs/plans/2026-04-15-multi-repo-auto-discovery-design.md`

**Conventions to match:**
- Tests use `describe`/`it`/`expect` from vitest; non-DB tests live under `tests/indexer/` or `tests/`; DB-touching tests go in `tests/integration/` and are gated by `process.env.INTEGRATION`.
- Commit prefixes mirror recent history: `feat(x):`, `fix(x):`, `refactor(x):`, `test(x):`, `docs(x):`.
- Type-check with `npm run lint` (tsc --noEmit). Run unit tests with `npm test`. Integration tests: `INTEGRATION=1 npm test`.
- Cypher helpers in `src/db/queries.ts` return `{ cypher, params }`; callers open a session and run them.
- Imports from local TS files use the `.js` extension (ESM).

---

### Task 1: Extend `Config` with `discovery` + `lastDiscoveredAt` and defaults

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
  it("applies default discovery settings", () => {
    const config = loadConfig(tempDir);
    expect(config.discovery.ttlHours).toBe(24);
    expect(config.discovery.maxDepth).toBe(6);
    expect(config.lastDiscoveredAt).toBeUndefined();
  });

  it("merges user-supplied discovery overrides", () => {
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify({ discovery: { ttlHours: 1 } })
    );
    const config = loadConfig(tempDir);
    expect(config.discovery.ttlHours).toBe(1);
    expect(config.discovery.maxDepth).toBe(6); // default preserved
  });

  it("reads lastDiscoveredAt when present", () => {
    const iso = "2026-04-15T12:00:00.000Z";
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify({ lastDiscoveredAt: iso })
    );
    const config = loadConfig(tempDir);
    expect(config.lastDiscoveredAt).toBe(iso);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `config.discovery` is undefined.

**Step 3: Implementation**

In `src/config.ts`:

```ts
export interface DiscoveryConfig {
  ttlHours: number;
  maxDepth: number;
}

export interface Config {
  neo4j: Neo4jConfig;
  index: IndexConfig;
  repos: RepoEntry[];
  discovery: DiscoveryConfig;
  lastDiscoveredAt?: string;
}
```

Add to `DEFAULT_CONFIG`:

```ts
  discovery: { ttlHours: 24, maxDepth: 6 },
```

Extend `deepMerge` to handle the two new keys:

```ts
  if (override.discovery) {
    result.discovery = { ...result.discovery, ...override.discovery };
  }
  if (override.lastDiscoveredAt !== undefined) {
    result.lastDiscoveredAt = override.lastDiscoveredAt;
  }
```

**Step 4: Verify**

Run: `npx vitest run tests/config.test.ts` → PASS. Then `npm run lint` → no errors.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add discovery settings and lastDiscoveredAt"
```

---

### Task 2: `saveConfig` writer

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { saveConfig } from "../src/config.js"; // add to existing import group at top

describe("saveConfig", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = join(tmpdir(), `cgr-save-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("creates .rho-graph.json when missing", () => {
    saveConfig(tempDir, { repos: [{ path: "svc-a" }], lastDiscoveredAt: "2026-04-15T00:00:00.000Z" });
    const parsed = JSON.parse(readFileSync(join(tempDir, ".rho-graph.json"), "utf-8"));
    expect(parsed.repos).toEqual([{ path: "svc-a" }]);
    expect(parsed.lastDiscoveredAt).toBe("2026-04-15T00:00:00.000Z");
  });

  it("preserves unrelated user-authored fields", () => {
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify({ neo4j: { uri: "bolt://custom:7687" }, repos: [{ path: "old" }] })
    );
    saveConfig(tempDir, { repos: [{ path: "new" }] });
    const parsed = JSON.parse(readFileSync(join(tempDir, ".rho-graph.json"), "utf-8"));
    expect(parsed.neo4j.uri).toBe("bolt://custom:7687");
    expect(parsed.repos).toEqual([{ path: "new" }]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `saveConfig` not exported.

**Step 3: Implementation**

In `src/config.ts`:

```ts
import { writeFileSync } from "node:fs";

export interface ConfigPatch {
  repos?: RepoEntry[];
  lastDiscoveredAt?: string;
}

export function saveConfig(repoRoot: string, patch: ConfigPatch): void {
  const path = join(repoRoot, ".rho-graph.json");
  const existing = (loadJsonFile(path) as Record<string, unknown> | null) ?? {};
  const next: Record<string, unknown> = { ...existing };
  if (patch.repos !== undefined) next.repos = patch.repos;
  if (patch.lastDiscoveredAt !== undefined) next.lastDiscoveredAt = patch.lastDiscoveredAt;
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
}
```

**Step 4: Verify**

Run: `npx vitest run tests/config.test.ts` → PASS. `npm run lint` → no errors.

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add saveConfig writer that preserves user fields"
```

---

### Task 3: `discoverRepos` BFS walk

**Files:**
- Create: `src/indexer/discover.ts`
- Test: `tests/indexer/discover.test.ts`

**Step 1: Write the failing test**

Create `tests/indexer/discover.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverRepos } from "../../src/indexer/discover.js";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mkRepo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

describe("discoverRepos", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds git subrepos at depth 1", () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    expect(found[0].name).toBe(found[0].path); // defaults to basename
  });

  it("does not descend into found repos", () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-a", "nested-repo"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["svc-a"]);
  });

  it("finds nested repos at deeper levels", () => {
    mkRepo(join(root, "group", "svc-a"));
    mkRepo(join(root, "group", "svc-b"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path).sort()).toEqual(["group/svc-a", "group/svc-b"]);
  });

  it("skips excluded directory names", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkRepo(join(root, "node_modules", "pkg"));
    mkRepo(join(root, "svc-a"));
    const found = discoverRepos(root, { exclude: ["node_modules"], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["svc-a"]);
  });

  it("respects maxDepth", () => {
    mkRepo(join(root, "a", "b", "c", "svc"));
    const shallow = discoverRepos(root, { exclude: [], maxDepth: 2 });
    expect(shallow).toEqual([]);
    const deeper = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(deeper.map((r) => r.path)).toEqual(["a/b/c/svc"]);
  });

  it("does not follow symlinks", () => {
    mkRepo(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"), "dir");
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["real"]);
  });

  it("returns empty when root itself has .git (caller's responsibility to short-circuit)", () => {
    mkRepo(root);
    mkRepo(join(root, "svc-a")); // shouldn't be reported — we don't descend into root because root is a repo
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/discover.test.ts`
Expected: FAIL — module not found.

**Step 3: Implementation**

Create `src/indexer/discover.ts`:

```ts
import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";

export interface DiscoveredRepo {
  path: string; // relative to root
  name: string; // basename by default
}

export interface DiscoverOptions {
  exclude: string[];
  maxDepth: number;
}

function isDir(p: string): boolean {
  try {
    // Use lstat to avoid following symlinks
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return false;
    return s.isDirectory();
  } catch {
    return false;
  }
}

function hasGitDir(p: string): boolean {
  try {
    const g = join(p, ".git");
    if (!existsSync(g)) return false;
    const s = statSync(g);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function discoverRepos(root: string, opts: DiscoverOptions): DiscoveredRepo[] {
  if (hasGitDir(root)) return [];

  const found: DiscoveredRepo[] = [];
  const excludeSet = new Set(opts.exclude);
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];

  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!;
    if (depth >= opts.maxDepth) continue;

    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (excludeSet.has(name)) continue;
      const child = join(abs, name);
      if (!isDir(child)) continue;

      if (hasGitDir(child)) {
        found.push({ path: relative(root, child), name: basename(child) });
        continue; // do not descend
      }
      queue.push({ abs: child, depth: depth + 1 });
    }
  }

  return found;
}
```

**Step 4: Verify**

Run: `npx vitest run tests/indexer/discover.test.ts` → PASS. `npm run lint` → no errors.

**Step 5: Commit**

```bash
git add src/indexer/discover.ts tests/indexer/discover.test.ts
git commit -m "feat(indexer): add discoverRepos BFS walk"
```

---

### Task 4: `resolveRepos` (TTL + reconciliation, no graph cleanup yet)

**Files:**
- Create: `src/indexer/resolve-repos.ts`
- Test: `tests/indexer/resolve-repos.test.ts`

**Step 1: Write the failing test**

Create `tests/indexer/resolve-repos.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRepos } from "../../src/indexer/resolve-repos.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

function mkRepo(dir: string) { mkdirSync(join(dir, ".git"), { recursive: true }); }

describe("resolveRepos", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns [] when root is itself a git repo", async () => {
    mkRepo(root);
    const { repos, mode } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(repos).toEqual([]);
    expect(mode).toBe("single");
  });

  it("walks and writes .rho-graph.json when cache is missing", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const { repos, mode } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(mode).toBe("workspace");
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    const written = JSON.parse(readFileSync(join(root, ".rho-graph.json"), "utf-8"));
    expect(written.lastDiscoveredAt).toBe("2026-04-15T00:00:00.000Z");
    expect(written.repos.map((r: { path: string }) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("uses cache when fresh (within ttlHours)", async () => {
    mkRepo(join(root, "svc-a"));
    writeFileSync(
      join(root, ".rho-graph.json"),
      JSON.stringify({
        repos: [{ path: "svc-a", name: "my-custom-name" }],
        lastDiscoveredAt: "2026-04-15T00:00:00.000Z",
      })
    );
    // Add a second repo AFTER the cache was written — should not be picked up.
    mkRepo(join(root, "svc-b"));

    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG, // ttlHours: 24
      now: new Date("2026-04-15T12:00:00Z"), // 12h later
      removeRepoFromGraph: async () => {},
    });
    expect(repos.map((r) => r.path)).toEqual(["svc-a"]);
    expect(repos[0].name).toBe("my-custom-name");
  });

  it("re-walks when cache is stale", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    writeFileSync(
      join(root, ".rho-graph.json"),
      JSON.stringify({
        repos: [{ path: "svc-a", name: "keep-me" }],
        lastDiscoveredAt: "2026-04-14T00:00:00.000Z",
      })
    );
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T12:00:00Z"), // 36h later, > 24h ttl
      removeRepoFromGraph: async () => {},
    });
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    expect(repos.find((r) => r.path === "svc-a")!.name).toBe("keep-me");
  });

  it("drops removed repos and invokes graph cleanup", async () => {
    // svc-a still present, svc-b had .git removed
    mkRepo(join(root, "svc-a"));
    mkdirSync(join(root, "svc-b"), { recursive: true });
    writeFileSync(
      join(root, ".rho-graph.json"),
      JSON.stringify({
        repos: [{ path: "svc-a" }, { path: "svc-b" }],
        lastDiscoveredAt: "2026-04-14T00:00:00.000Z", // stale
      })
    );
    const removed: string[] = [];
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-16T00:00:00Z"),
      removeRepoFromGraph: async (absPath) => { removed.push(absPath); },
    });
    expect(repos.map((r) => r.path)).toEqual(["svc-a"]);
    expect(removed).toEqual([join(root, "svc-b")]);
  });

  it("returns [] in single mode when no repos discovered under non-git root", async () => {
    const { repos, mode, warning } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(repos).toEqual([]);
    expect(mode).toBe("single");
    expect(warning).toMatch(/no.*repos.*discovered/i);
  });

  it("force: true bypasses TTL cache", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    writeFileSync(
      join(root, ".rho-graph.json"),
      JSON.stringify({
        repos: [{ path: "svc-a" }],
        lastDiscoveredAt: "2026-04-15T00:00:00.000Z",
      })
    );
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T01:00:00Z"), // would normally be fresh
      removeRepoFromGraph: async () => {},
      force: true,
    });
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/resolve-repos.test.ts`
Expected: FAIL — module not found.

**Step 3: Implementation**

Create `src/indexer/resolve-repos.ts`:

```ts
import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Config, RepoEntry } from "../config.js";
import { saveConfig } from "../config.js";
import { discoverRepos } from "./discover.js";

export type ResolveMode = "workspace" | "single";

export interface ResolveReposArgs {
  workspaceRoot: string;
  config: Config;
  now?: Date;
  force?: boolean;
  removeRepoFromGraph: (absPath: string) => Promise<void>;
}

export interface ResolveReposResult {
  repos: RepoEntry[];
  mode: ResolveMode;
  added: string[];
  removed: string[];
  warning?: string;
}

function rootIsGitRepo(root: string): boolean {
  const g = join(root, ".git");
  if (!existsSync(g)) return false;
  try { return statSync(g).isDirectory(); } catch { return false; }
}

function isCacheFresh(
  lastDiscoveredAt: string | undefined,
  ttlHours: number,
  now: Date
): boolean {
  if (!lastDiscoveredAt) return false;
  const last = Date.parse(lastDiscoveredAt);
  if (Number.isNaN(last)) return false;
  const ageMs = now.getTime() - last;
  return ageMs >= 0 && ageMs < ttlHours * 3600 * 1000;
}

export async function resolveRepos(args: ResolveReposArgs): Promise<ResolveReposResult> {
  const { workspaceRoot, config, removeRepoFromGraph } = args;
  const now = args.now ?? new Date();

  if (rootIsGitRepo(workspaceRoot)) {
    return { repos: [], mode: "single", added: [], removed: [] };
  }

  const fresh =
    !args.force &&
    config.repos.length > 0 &&
    isCacheFresh(config.lastDiscoveredAt, config.discovery.ttlHours, now);

  if (fresh) {
    return { repos: config.repos, mode: "workspace", added: [], removed: [] };
  }

  const discovered = discoverRepos(workspaceRoot, {
    exclude: config.index.exclude,
    maxDepth: config.discovery.maxDepth,
  });
  const discoveredPaths = new Set(discovered.map((d) => d.path));

  // Preserve user-set names for paths that still exist.
  const existingByPath = new Map(config.repos.map((r) => [r.path, r]));
  const merged: RepoEntry[] = discovered.map((d) => existingByPath.get(d.path) ?? { path: d.path, name: d.name });

  // Stored paths no longer discovered → removed.
  const removedEntries = config.repos.filter((r) => !discoveredPaths.has(r.path));
  for (const r of removedEntries) {
    await removeRepoFromGraph(resolve(workspaceRoot, r.path));
  }

  const added = discovered
    .map((d) => d.path)
    .filter((p) => !existingByPath.has(p));
  const removed = removedEntries.map((r) => r.path);

  if (merged.length === 0) {
    return {
      repos: [],
      mode: "single",
      added,
      removed,
      warning: `No git subrepos discovered under ${workspaceRoot}. Falling back to single-repo mode.`,
    };
  }

  saveConfig(workspaceRoot, {
    repos: merged,
    lastDiscoveredAt: now.toISOString(),
  });

  return { repos: merged, mode: "workspace", added, removed };
}
```

**Step 4: Verify**

Run: `npx vitest run tests/indexer/resolve-repos.test.ts` → PASS. `npm run lint` → no errors.

**Step 5: Commit**

```bash
git add src/indexer/resolve-repos.ts tests/indexer/resolve-repos.test.ts
git commit -m "feat(indexer): add resolveRepos with TTL-cached discovery"
```

---

### Task 5: Graph cleanup query for removed subrepo

**Files:**
- Modify: `src/db/queries.ts`
- Test: `tests/db/queries.test.ts` (create if missing — check first)

**Step 1: Check if `tests/db/queries.test.ts` exists**

Run: `ls tests/db/` to see existing files. If there's no shape-check style test harness yet, create one focused only on the new query.

**Step 2: Write the failing test**

Create or append `tests/db/queries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deleteRepositoryAndFiles } from "../../src/db/queries.js";

describe("deleteRepositoryAndFiles", () => {
  it("returns a query scoped to the given repo path", () => {
    const q = deleteRepositoryAndFiles({ repoPath: "/abs/root/svc-a" });
    expect(q.cypher).toContain("STARTS WITH $repoPath");
    expect(q.cypher).toContain("DETACH DELETE");
    expect(q.params).toEqual({ repoPath: "/abs/root/svc-a" });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db/queries.test.ts`
Expected: FAIL — export does not exist.

**Step 4: Implementation**

Append to `src/db/queries.ts`:

```ts
/**
 * Delete a Repository node, every File under it, and all Function/Class
 * children of those files. Used when a previously-known subrepo is no longer
 * present (its .git directory was removed or the directory itself was deleted).
 *
 * Intentionally one statement — Neo4j handles DETACH DELETE of connected
 * children in a single tx. If you hit memory pressure on very large repos,
 * chunk by file prefix the same way batchDeleteOrphanFiles does.
 */
export function deleteRepositoryAndFiles(data: { repoPath: string }): CypherQuery {
  return {
    cypher: `
      OPTIONAL MATCH (r:Repository {path: $repoPath})
      OPTIONAL MATCH (f:File) WHERE f.path STARTS WITH $repoPath
      OPTIONAL MATCH (f)-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child, f, r
    `,
    params: data,
  };
}
```

**Step 5: Verify**

Run: `npx vitest run tests/db/queries.test.ts` → PASS. `npm run lint` → no errors.

**Step 6: Commit**

```bash
git add src/db/queries.ts tests/db/queries.test.ts
git commit -m "feat(db): add deleteRepositoryAndFiles query"
```

---

### Task 6: Wire `resolveRepos` into `index` and `init` commands

**Files:**
- Modify: `src/cli/commands/index-cmd.ts`
- Modify: `src/cli/commands/init.ts`
- Create: `src/indexer/graph-cleanup.ts` (small helper around the new query)

**Step 1: Write the helper**

Create `src/indexer/graph-cleanup.ts`:

```ts
import type { DbConnection } from "../db/connection.js";
import { deleteRepositoryAndFiles } from "../db/queries.js";

export async function removeRepoFromGraph(db: DbConnection, absPath: string): Promise<void> {
  const session = db.session();
  try {
    const q = deleteRepositoryAndFiles({ repoPath: absPath });
    await session.run(q.cypher, q.params);
  } finally {
    await session.close();
  }
}
```

**Step 2: Modify `src/cli/commands/index-cmd.ts`**

At the top of the `.action` body, after `const maxMemoryMB = ...`, replace the `useWorkspace` block with a call to `resolveRepos`.

```ts
// src/cli/commands/index-cmd.ts
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
```

Replace:

```ts
const useWorkspace = config.repos.length > 0 && !opts.repo && !opts.path;

if (useWorkspace) { ... }
```

with:

```ts
let repos = config.repos;
let useWorkspace = false;

if (!opts.repo && !opts.path) {
  const resolved = await resolveRepos({
    workspaceRoot,
    config,
    removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
  });
  repos = resolved.repos;
  useWorkspace = resolved.mode === "workspace";
  if (resolved.warning) console.warn(resolved.warning);
  if (resolved.added.length > 0) console.log(`Discovered new repos: ${resolved.added.join(", ")}`);
  if (resolved.removed.length > 0) console.log(`Removed missing repos: ${resolved.removed.join(", ")}`);
}

if (useWorkspace) {
  const spinner = ora(`Indexing workspace (${repos.length} repos)...`).start();
  const result = await indexWorkspace(db, workspaceRoot, repos, config.index, { /* existing opts */ });
  // ... existing reporting unchanged
  await db.close();
  return;
}
```

Keep the existing single-repo branch unchanged — it runs when `useWorkspace` is false.

**Step 3: Modify `src/cli/commands/init.ts`** — same pattern: call `resolveRepos` before the existing branch. Replace:

```ts
if (config.repos.length > 0) { ... } else { ... }
```

with:

```ts
const resolved = await resolveRepos({
  workspaceRoot: repoPath,
  config,
  removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
});
if (resolved.warning) console.warn(resolved.warning);

if (resolved.mode === "workspace") {
  // existing indexWorkspace branch, using resolved.repos instead of config.repos
} else {
  // existing indexRepository branch
}
```

**Step 4: Verify types and existing tests**

Run: `npm run lint` → no errors. Then `npm test` → all existing tests still pass (none of them exercise the CLI directly).

**Step 5: Commit**

```bash
git add src/cli/commands/index-cmd.ts src/cli/commands/init.ts src/indexer/graph-cleanup.ts
git commit -m "feat(cli): wire resolveRepos into init and index"
```

---

### Task 7: `rho-graph discover` command

**Files:**
- Create: `src/cli/commands/discover.ts`
- Modify: `src/cli/index.ts`

**Step 1: Implement the command**

Create `src/cli/commands/discover.ts`:

```ts
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
import { discoverRepos } from "../../indexer/discover.js";

export function registerDiscoverCommand(program: Command): void {
  program
    .command("discover")
    .description("Walk the root for microservice subrepos and update .rho-graph.json")
    .option("--dry-run", "Show what would change without writing or touching the graph")
    .action(async (opts) => {
      const workspaceRoot = resolve(".");
      const config = loadConfig(workspaceRoot);

      if (opts.dryRun) {
        const discovered = discoverRepos(workspaceRoot, {
          exclude: config.index.exclude,
          maxDepth: config.discovery.maxDepth,
        });
        const existing = new Set(config.repos.map((r) => r.path));
        const discoveredSet = new Set(discovered.map((d) => d.path));
        const added = discovered.map((d) => d.path).filter((p) => !existing.has(p));
        const removed = config.repos.map((r) => r.path).filter((p) => !discoveredSet.has(p));
        console.log(`Discovered ${discovered.length} repos:`);
        for (const d of discovered) console.log(`  ${d.path}`);
        if (added.length) console.log(`Would add: ${added.join(", ")}`);
        if (removed.length) console.log(`Would remove: ${removed.join(", ")}`);
        if (!added.length && !removed.length) console.log("No changes.");
        return;
      }

      const db = createConnection(config.neo4j);
      try {
        const result = await resolveRepos({
          workspaceRoot,
          config,
          force: true,
          removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
        });
        if (result.warning) console.warn(result.warning);
        console.log(`Discovered ${result.repos.length} repos:`);
        for (const r of result.repos) console.log(`  ${r.path}`);
        if (result.added.length) console.log(`Added: ${result.added.join(", ")}`);
        if (result.removed.length) console.log(`Removed: ${result.removed.join(", ")}`);
      } finally {
        await db.close();
      }
    });
}
```

**Step 2: Register in `src/cli/index.ts`**

```ts
import { registerDiscoverCommand } from "./commands/discover.js";
// ...
registerDiscoverCommand(program);
```

**Step 3: Verify**

Run: `npm run lint`. Then a smoke build: `npm run build`. Confirm `dist/cli/commands/discover.js` exists.

**Step 4: Commit**

```bash
git add src/cli/commands/discover.ts src/cli/index.ts
git commit -m "feat(cli): add discover command with --dry-run"
```

---

### Task 8: End-to-end integration test for "pure container" indexing

**Files:**
- Modify: `tests/integration/microservices.test.ts` (add a new describe block)

**Step 1: Write the failing test**

Append to `tests/integration/microservices.test.ts`:

```ts
import { mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { resolveRepos } from "../../src/indexer/resolve-repos.js";
import { removeRepoFromGraph } from "../../src/indexer/graph-cleanup.js";

describe.skipIf(!INTEGRATION)("pure-container discovery integration", () => {
  let db: ReturnType<typeof createConnection>;
  let tmpRoot: string;

  beforeAll(async () => {
    db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);

    // Build a pure-container: two existing fixture microservices copied into
    // a fresh temp root, with .git dirs added to simulate real repos.
    tmpRoot = join(tmpdir(), `pure-container-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    for (const svc of ["auth-service", "user-service"]) {
      const src = resolve("tests/fixtures/microservices", svc);
      const dst = join(tmpRoot, svc);
      cpSync(src, dst, { recursive: true });
      mkdirSync(join(dst, ".git"), { recursive: true });
    }

    // Clean any prior graph nodes that might alias these paths.
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root: tmpRoot });
      await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root: tmpRoot });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root: tmpRoot });
      await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root: tmpRoot });
    } finally {
      await session.close();
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    await db.close();
  });

  it("discovers subrepos and indexes each as its own Repository node", async () => {
    const config = loadConfig(tmpRoot);
    const resolved = await resolveRepos({
      workspaceRoot: tmpRoot,
      config,
      removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
    });
    expect(resolved.mode).toBe("workspace");
    expect(resolved.repos.map((r) => r.path).sort()).toEqual(["auth-service", "user-service"]);

    const result = await indexWorkspace(db, tmpRoot, resolved.repos, DEFAULT_CONFIG.index);
    expect(result.repos.length).toBe(2);

    const session = db.session();
    try {
      const res = await session.run(
        "MATCH (r:Repository) WHERE r.path STARTS WITH $root RETURN r.path AS path ORDER BY path",
        { root: tmpRoot }
      );
      const paths = res.records.map((r) => r.get("path") as string);
      expect(paths).toEqual([join(tmpRoot, "auth-service"), join(tmpRoot, "user-service")]);
    } finally {
      await session.close();
    }

    // .rho-graph.json was written
    expect(existsSync(join(tmpRoot, ".rho-graph.json"))).toBe(true);
  });

  it("removes the Repository node when a subrepo's .git disappears", async () => {
    // Remove .git from user-service, then re-resolve with force
    rmSync(join(tmpRoot, "user-service", ".git"), { recursive: true, force: true });
    const config = loadConfig(tmpRoot);
    const resolved = await resolveRepos({
      workspaceRoot: tmpRoot,
      config,
      force: true,
      removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
    });
    expect(resolved.repos.map((r) => r.path)).toEqual(["auth-service"]);
    expect(resolved.removed).toEqual(["user-service"]);

    const session = db.session();
    try {
      const res = await session.run(
        "MATCH (r:Repository) WHERE r.path = $p RETURN count(r) AS c",
        { p: join(tmpRoot, "user-service") }
      );
      expect(res.records[0].get("c").toNumber()).toBe(0);
      const files = await session.run(
        "MATCH (f:File) WHERE f.path STARTS WITH $p RETURN count(f) AS c",
        { p: join(tmpRoot, "user-service") }
      );
      expect(files.records[0].get("c").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
```

**Step 2: Run the integration test**

Start Neo4j (if not already): `docker compose up -d`
Run: `INTEGRATION=1 npx vitest run tests/integration/microservices.test.ts -t "pure-container"`
Expected: both tests PASS.

**Step 3: Run the full test suite**

Run: `npm test` (unit) and `INTEGRATION=1 npm test` (full).
Expected: all green.

**Step 4: Commit**

```bash
git add tests/integration/microservices.test.ts
git commit -m "test(integration): verify pure-container discovery and cleanup"
```

---

### Task 9: Update README with the multi-repo usage note

**Files:**
- Modify: `README.md`

**Step 1: Add a section after `## Quick start`**

Insert a short section:

```markdown
## Multi-repo root (microservices)

If you run `rho-graph init` or `index` from a directory that is not itself a git repo but contains microservice repos as subdirectories, rho-graph walks the tree to find them (any dir containing `.git/` is treated as a repo; walk stops at found repos and at `index.exclude` dirs like `node_modules`). The discovered list is written to `.rho-graph.json` and refreshed every 24h (configurable via `discovery.ttlHours`).

Force a refresh manually:

```bash
rho-graph discover            # walks and updates .rho-graph.json
rho-graph discover --dry-run  # preview changes, write nothing
```
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document multi-repo root support"
```

---

## Rollout order summary

Tasks 1 → 9, sequentially. Each task has its own test + commit. Tasks 1–5 are pure unit work; Task 6 is the wire-up; Task 7 is the new CLI surface; Task 8 is the end-to-end proof; Task 9 is user-facing docs.

## Out of scope (explicit non-goals)

- Root is itself a git repo (submodules) — detected and skipped to single-repo mode. Future work.
- Excludes for discovered subrepos — user said "trust the repo"; no exclude list.
- Background / daemon-driven rediscovery — the TTL cache covers the same need without adding a process.
