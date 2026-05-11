# Multi-repo auto-discovery design

**Date:** 2026-04-15
**Status:** Design approved, implementation plan pending

## Problem

When rho-graph is run from a root directory that contains multiple microservice subdirectories (each its own git repo), the current behavior is wrong:

- The root is not a git repo, so `getGitFiles` returns null and the indexer falls back to glob, which crawls across subrepo boundaries.
- `indexRepository(root)` writes a single `Repository` node for the root and attributes every file under every subrepo to it.
- The subdirectories never get classified as repos.

The existing workaround — manually authoring `.rho-graph.json` with a `repos: [...]` array — works but is not discoverable and does not adapt when subrepos are added or removed.

## Scope

In scope: the "pure container" layout — root is not a git repo, holds microservice subrepos at arbitrary depth, has no code of its own.

Out of scope for now: root is itself a git repo (submodule / nested clone cases). When detected, we fall through to current single-repo behavior.

## Architecture

### Discovery

New module `src/indexer/discover.ts` exporting `discoverRepos(root, config)`:

- BFS walk from `root`.
- For each dir: if it contains `.git/`, record it as a repo and do **not** descend further (no repos inside repos).
- Otherwise descend, skipping anything matched by `config.index.exclude` (already covers `node_modules`, `.venv`, etc.).
- Hard depth cap (default 6, configurable via `discovery.maxDepth`) as a safety net.
- Do not follow symlinks.
- Returns `{ path, name }[]` with paths relative to `root`.

### Resolution

New helper `resolveRepos(config, workspaceRoot)`:

1. Read `.rho-graph.json` raw → `repos[]` and `lastDiscoveredAt`.
2. If root is itself a git repo → return `[]` (signals single-repo mode to callers).
3. If cache fresh (< `discovery.ttlHours`, default 24h) and `repos` non-empty → return list as-is.
4. Otherwise run `discoverRepos`, reconcile against stored list, update `lastDiscoveredAt`, write back.
5. For stored paths whose `.git` is missing on disk → warn, remove from file, delete the `Repository` node and its files from the graph.

Reconciliation rules:
- Discovered path already in `repos` → keep existing entry (preserves user-set `name`).
- Discovered path missing → append `{ path: <relative-to-root>, name: basename }`.
- Stored path not discovered → remove, trigger graph cleanup.

### Integration

- `init` and `index` commands call `resolveRepos` before dispatching.
- Non-empty returned list → `indexWorkspace`.
- Empty list → current `indexRepository` path (warning logged if no `.git` found anywhere under a non-repo root).
- `--repo <path>` continues to short-circuit to single-repo mode.
- No changes to `indexRepository` or `indexWorkspace` themselves.

## Config schema

Additions to `Config`:

```ts
interface DiscoveryConfig {
  ttlHours: number;  // default 24
  maxDepth: number;  // default 6
}

interface Config {
  neo4j: Neo4jConfig;
  index: IndexConfig;
  repos: RepoEntry[];
  discovery: DiscoveryConfig;   // NEW, defaults applied
  lastDiscoveredAt?: string;    // NEW, ISO timestamp, managed by us
}
```

`RepoEntry` (`{ path, name? }`) unchanged.

### Write-back

New `saveConfig(repoRoot, patch)` in `src/config.ts`:
- Reads existing `.rho-graph.json` raw (bypasses `loadConfig`'s merge so globals/env don't leak into the file).
- Shallow-merges `patch` (`repos`, `lastDiscoveredAt`).
- Creates file if missing.
- Pretty-printed JSON, stable key order.
- Stores `repos` paths relative to `workspaceRoot` for portability.

`discovery` values are not persisted unless the user sets them themselves.

## CLI

- `init` — unchanged surface; gains multi-repo behavior via `resolveRepos`.
- `index` — unchanged surface; same.
- `discover` — new command:
  - Forces a walk regardless of TTL.
  - `--dry-run` prints added/removed, writes nothing.
  - Default writes `.rho-graph.json` and prints the reconciled list. Does not auto-index.
- `status` — unchanged; will naturally show multiple `Repository` nodes.

## Graph cleanup

New query `deleteRepositoryAndFiles({ repoPath })` in `src/db/queries.ts`:
- `DETACH DELETE` the `Repository` node, all `File` nodes under `path STARTS WITH repoPath`, and their `Function`/`Class` children.
- Chunked (like `batchDeleteOrphanFiles`) to stay under Neo4j's per-tx memory budget.
- Same safety rail as `cleanOrphanedFiles`: if the query would delete more files than expected, log and skip (guard against a transient "`.git` temporarily missing" blip).

## Edge cases

- Root itself is a git repo → discovery skipped, single-repo mode.
- `.rho-graph.json` missing → created on first `init` / `discover`.
- No `.git` found anywhere under a non-repo root → warning logged; falls through to single-repo mode on root.
- Stored path points at a deleted directory → same removal path as missing-`.git`.
- Symlinks encountered during walk → not followed.

## Testing

Unit:
- `discoverRepos` against fixture trees: nested `.git` dirs, excluded dirs, depth cap, symlinks.
- `resolveRepos` TTL: fresh cache skips walk; stale triggers walk; missing file triggers walk.
- Reconciliation: added / removed / renamed cases preserve user-set `name`.
- `saveConfig`: round-trip preserves user-authored fields.

Integration:
- End-to-end `init` against a fixture "pure container" with 2 subrepos → 2 `Repository` nodes, files attributed correctly, cross-repo RPC linking still works.
- Remove a subrepo's `.git`, re-run `discover` + `index` → `Repository` node and files removed from graph.
