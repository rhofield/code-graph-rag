# Graph Visualization Overhaul — Design

**Date:** 2026-04-08
**Status:** Design (awaiting implementation plan)
**Scope:** `src/visualize/` (server + browser UI), `src/cli/commands/visualize.ts`, `README.md` schema fix, new tests under `tests/unit/visualize/` and `tests/integration/visualize/`.

## Background

The `code-graph-rag visualize` command opens a browser-based graph view of the indexed code graph. Today it has two classes of problems:

1. **Broken filter flags.** `--file <path>` and `--function <name>` are accepted by Commander and passed into `opts.filter` but `src/visualize/server.ts:handleRequest` only branches on `opts.filter.repo`. The other flags are silently ignored, so the user always sees the full graph regardless. The `--repo` branch itself misses class methods because it stops at `[:CONTAINS]` and never traverses `[:HAS_METHOD]`.
2. **Cluttered, unreadable layout.** Default vis-network physics (`barnesHut`) is untuned for ~500 node graphs, all edge types render in identical gray, edge labels render always-on, all nodes are the same size, and there is no in-browser way to filter or focus. The result is a hairball of overlapping nodes and crisscrossing edges that conveys very little.

A third, smaller issue surfaced during exploration: **the README schema table is wrong.** It documents `[:DEFINES]` for File→symbol and `(Class)-[:CONTAINS]->(Function)` for class methods, but the indexer (per `src/db/queries.ts:78,98,64`) actually writes `[:CONTAINS]` and `[:HAS_METHOD]`. We fix the README as part of this work.

## Goals

- Make `--file` and `--function` filter flags actually work, end-to-end.
- Replace the "open and stare at a hairball" experience with an interactive exploration UI: open to a clean overview, drill in by clicking, filter by node/edge type from a sidebar, search by name.
- Tune vis-network physics and styling so even a 500-node graph is readable on first load.
- Fix the README schema documentation to match the actual graph.

## Non-goals

- Migrating off vis-network (e.g. to Cytoscape.js or D3). This is a separate, much larger project. The current problems are tunability and missing features, not library limits.
- Server-side caching, websockets, or live re-indexing. The graph is read-only per session; "Reset everything" is the explicit refresh path.
- A browser test framework (Playwright/Vitest-browser). The client-side logic stays small enough to cover via manual dogfooding plus integration tests against the HTTP layer.

## Architecture

### High-level flow

```
                  ┌─ CLI flags (--repo/--file/--function) ──┐
                  │                                          ▼
   visualize.ts ──┴──> server.ts ──> /api/graph?<filter>     /api/expand?<id>     /api/search?q=
                                          │                       │                    │
                                          ▼                       ▼                    ▼
                                    queries.ts (Cypher)   queries.ts (Cypher)   queries.ts (Cypher)
                                          │                       │                    │
                                          ▼                       ▼                    ▼
                                                              Neo4j

   Browser
   ┌──────────────────────────────────────────────────────────────┐
   │ index.html (sidebar + canvas + detail panel)                 │
   │ graph.js                                                     │
   │   ├── viewState  (toggles, search term, click history)       │
   │   ├── loadedSet  (vis-network DataSets — source of truth)    │
   │   ├── api        (fetch wrappers)                            │
   │   ├── render     (vis-network init + applyViewFilters)       │
   │   └── sidebar    (DOM event handlers → viewState)            │
   └──────────────────────────────────────────────────────────────┘
```

### Two-layer state model

| Layer | What it holds | Mutated by |
|---|---|---|
| `loadedSet` (server-loaded) | Every node/edge fetched from Neo4j so far in this session | Initial fetch + click-to-expand |
| `viewState` (client-only) | Which subsets of `loadedSet` are visible right now | Sidebar toggles, search box |

The single function `applyViewFilters()` walks `loadedSet` and sets `hidden: true/false` on each item based on `viewState`. Search highlight works the same way (`highlighted: true` flag, no mutation of the underlying set). Resetting view filters preserves `loadedSet`; "Reset everything" re-runs the initial fetch and clears `loadedSet`.

This split — what we **have** versus what we **show** — is what makes interactive filtering feel snappy: sidebar toggles never hit the network, only "ask for new data" interactions do.

### File layout

```
src/visualize/
  server.ts          # HTTP entry — slimmed to dispatch + static serving
  queries.ts         # NEW: Cypher builders for read-side visualization queries
  public/
    index.html       # sidebar markup added
    graph.js         # restructured as one file with named sections
```

`src/visualize/queries.ts` is intentionally separate from `src/db/queries.ts` because the indexer queries are write-side (`MERGE`/`SET`) and the visualization queries are read-side with shape-changing `RETURN` clauses. Mixing them in one file makes both harder to read.

`graph.js` stays as one file rather than splitting into ES modules — it's small enough (under ~600 lines projected) that the cognitive overhead of `<script type="module">` and import maps isn't worth it.

## Components

### Server-side: `src/visualize/queries.ts` (NEW)

Cypher query builders, each returning `{ cypher, params }` matching the convention used by `src/db/queries.ts`.

| Function | Returns | Used by |
|---|---|---|
| `repoOverview(repoName?)` | Repository node + all its Files + IMPORTS edges between those files. No symbols. | Default initial fetch (no flags or only `--repo`) |
| `filterByFile(relativePath)` | The matching File + its symbols (Functions, Classes, class methods via `:HAS_METHOD`) | `--file` initial fetch |
| `filterByFunction(name)` | All Functions matching `name` (may be multiple) + each one's containing File + 1-hop CALLS neighborhood | `--function` initial fetch |
| `expandFile(filePath)` | Functions, Classes, and class methods owned by this File | Click-to-expand on a File node |
| `expandFunction(name, filePath)` | 1-hop callers and callees of this Function | Click-to-expand on a Function node |
| `searchByName(prefix, limit)` | Matching Functions, Classes, and Files (full-text via the `code_search` index) | `/api/search` |

`filterByFunction` and `expandFunction` look similar but are deliberately separate: the initial filter also fetches the containing File for context, while expand assumes the parent is already loaded and only adds the new neighbors. Conflating them is a known bug pattern; keeping them separate keeps each Cypher query simple.

Limit constants live in `queries.ts` as named exports:
- `INITIAL_LIMIT = 500` (overview / filtered initial fetch)
- `EXPAND_FILE_LIMIT = 100` (children of one file)
- `EXPAND_FUNCTION_LIMIT = 50` (1-hop neighborhood)
- `SEARCH_LIMIT = 25`

### Server-side: `src/visualize/server.ts` (MODIFIED)

`handleRequest` becomes a small dispatcher. All Cypher disappears from this file:

```
GET /api/graph                          → chooses query by which CLI flag was passed
GET /api/graph?repo=...                 → repoOverview
GET /api/graph?file=...                 → filterByFile
GET /api/graph?function=...             → filterByFunction
GET /api/expand?type=file&id=...        → expandFile
GET /api/expand?type=function&name=...&filePath=... → expandFunction
GET /api/search?q=...                   → searchByName
```

Each handler keeps its own try/catch returning `500 + { error: string }` (the existing pattern at `server.ts:83-89`). Static file serving and the WSL2-aware `openBrowser` helper are untouched.

### Server-side: `src/cli/commands/visualize.ts` (NO functional change)

The CLI surface stays identical. The flags already pass through; we only need them to actually shape the initial query selection in `server.ts`.

### Browser: `src/visualize/public/index.html` (MODIFIED)

Add a left-rail sidebar (~240px) between `#header` and `#main`, containing:

- **Search box** — text input, filters/highlights matching loaded nodes; if no match in `loadedSet`, hits `/api/search`.
- **Node type checkboxes** — Repository, File, Class, Function (all checked by default).
- **Edge type checkboxes** — CONTAINS_FILE, CONTAINS, HAS_METHOD, IMPORTS, CALLS (checked); IMPORTS_SYMBOL (unchecked — too noisy by default, opt-in).
- **Legend** — color swatch + label for each node type.
- **Buttons:** "Reset view" (clears toggles, keeps loaded data), "Reset everything" (re-runs initial fetch), "Freeze layout" (toggles physics on/off).
- **Loaded counter** — "Loaded: 142 nodes, 318 edges" so the user knows how much state is held.

The existing right-side detail panel remains unchanged.

### Browser: `src/visualize/public/graph.js` (RESTRUCTURED)

One file, organized into named sections:

```js
// === STATE ===
const viewState = {
  search: '',
  visibleNodeTypes: new Set(['Repository', 'File', 'Class', 'Function']),
  visibleEdgeTypes: new Set(['CONTAINS_FILE', 'CONTAINS', 'HAS_METHOD', 'IMPORTS', 'CALLS']),
};
const loadedSet = { nodes: new vis.DataSet(), edges: new vis.DataSet() };
const pendingExpands = new Set();   // race-condition guard for rapid clicks
let network;

// === API ===
async function fetchGraph(params) { /* GET /api/graph?... */ }
async function fetchExpand(type, id) { /* GET /api/expand?... */ }
async function fetchSearch(q) { /* GET /api/search?q=... */ }

// === MERGE (server response → loadedSet) ===
function mergeIntoLoaded({ nodes, edges }) {
  // Idempotent: vis.DataSet.update is upsert by id, so duplicate clicks are safe.
  // Tags merged nodes with _expandedBy: Set<parentId> for collapse bookkeeping.
}

// === RENDER ===
function initNetwork() { /* one-time vis.Network construction with tuned options */ }
function applyViewFilters() {
  // The ONLY function that mutates rendered visibility based on viewState.
}
function recomputeNodeSizes() {
  // Walks loadedSet.edges, computes degrees, calls degreeToSize, updates nodes.
}

// === EVENTS ===
function onNodeClick(params) { /* expand if not yet expanded, else update detail panel */ }
function onNodeDoubleClick(params) { /* collapse — see semantics below */ }
function onSearchInput(e) { /* update viewState.search, applyViewFilters, optionally fetchSearch */ }
function onNodeTypeToggle(type, checked) { /* mutate viewState, applyViewFilters */ }
function onEdgeTypeToggle(type, checked) { /* same */ }

// === BOOT ===
async function boot() {
  initNetwork();
  bindSidebarEvents();
  const initial = await fetchGraph(parseUrlFilters());
  mergeIntoLoaded(initial);
  recomputeNodeSizes();
  applyViewFilters();
}
```

### Click semantics

1. **Click a File not yet expanded** → `fetchExpand('file', id)` → `mergeIntoLoaded` → `recomputeNodeSizes` → `applyViewFilters`. Detail panel updates as a side effect.
2. **Click a Function not yet expanded** → `fetchExpand('function', name+filePath)` → same flow.
3. **Click a Repository node** → just opens the detail panel. Its child Files are already loaded in the default `repoOverview` fetch, so there's nothing to expand. (If we ever support multi-repo views where individual repos lazy-load, this changes.)
4. **Click a Class** → expand its methods via `expandFile` semantics on the parent File, scoped to the class. Practically: a Class's methods come from `(Class)-[:HAS_METHOD]->(Function)`, which is already part of `expandFile`'s result, so most users will see methods appear when they expand the File. Clicking a Class directly is a no-op + detail panel update.
5. **Click an already-expanded node** → just update the detail panel; no fetch. The `_expanded: true` flag (set during merge) prevents re-fetch.
6. **Double-click a File or Function** → collapse: remove children that are not also `_expandedBy` another currently-expanded parent.

The `_expandedBy: Set<parentId>` map handles the shared-neighbor case: if function A and function B both call function C, expanding A loads C tagged with `_expandedBy: {A}`. Expanding B updates the tag to `{A, B}`. Collapsing A removes A from the set, leaves C alone because B still references it. Only when the set becomes empty does C get removed.

### Visual / physics tuning

```js
physics: {
  solver: 'forceAtlas2Based',
  forceAtlas2Based: {
    gravitationalConstant: -50,
    centralGravity: 0.01,
    springLength: 150,
    springConstant: 0.08,
    damping: 0.4,
    avoidOverlap: 0.5,         // ← directly prevents node-on-node overlap
  },
  stabilization: { iterations: 250, updateInterval: 25 },
  minVelocity: 0.5,            // freeze when motion is small → no endless wobble
}

edges: {
  smooth: { type: 'continuous', roundness: 0.2 },
  font: { size: 0, strokeWidth: 0 },          // labels off by default
  arrows: { to: { scaleFactor: 0.6 } },
}
```

`forceAtlas2Based` (the same algorithm Gephi uses by default) handles cyclical graphs much better than `barnesHut`, which is optimized for tree-like structures. `avoidOverlap` is the single most impactful change — it adds a soft repulsion between node bodies that directly stops the "two nodes drawn on top of each other" failure mode.

Edge type colors (initial draft, subject to refinement):

```js
const EDGE_STYLES = {
  CONTAINS_FILE:  { color: '#1f6feb', width: 1 },
  CONTAINS:       { color: '#1a7f37', width: 1 },
  HAS_METHOD:     { color: '#8957e5', width: 1 },
  IMPORTS:        { color: '#d29922', width: 1.5 },
  CALLS:          { color: '#da3633', width: 1 },
  IMPORTS_SYMBOL: { color: '#6e7681', width: 1, dashes: true },
};
```

Node sizing by degree:

```js
function degreeToSize(degree) {
  return Math.min(35, 12 + Math.sqrt(degree) * 4);
}
```

The square-root mapping gives diminishing returns for hubs while keeping a 4-degree node visibly distinct from a 16-degree one. Low-impact functions stay small, hubs visibly pop without dominating.

Edge labels reappear on hover via vis-network's `hoverConnectedEdges` interaction.

## Data flow examples

### Default open

1. User runs `code-graph-rag visualize`.
2. Browser opens, `boot()` runs.
3. `parseUrlFilters()` returns `{}` → `fetchGraph({})` → server calls `repoOverview(undefined)` → returns Repository + Files + IMPORTS.
4. `mergeIntoLoaded` populates `loadedSet`. `recomputeNodeSizes` computes degrees. `applyViewFilters` shows everything (default `viewState`).
5. User sees a clean architectural view of files-and-imports.

### Drill-in via click

1. User clicks `src/auth/middleware.ts`.
2. `onNodeClick` sees `_expanded` is not set → calls `fetchExpand('file', id)`.
3. Server calls `expandFile(filePath)` → returns the file's Functions, Classes, and class methods.
4. `mergeIntoLoaded` adds them, marking each as `_expandedBy: {fileId}`. The file node itself gets `_expanded: true`.
5. `recomputeNodeSizes` + `applyViewFilters`. New nodes appear connected to the file; the layout settles.

### Sidebar toggle (instant, no fetch)

1. User unchecks "Class".
2. `onNodeTypeToggle('Class', false)` removes 'Class' from `viewState.visibleNodeTypes`.
3. `applyViewFilters` walks `loadedSet`, sets `hidden: true` on every Class node and on edges connected to those nodes.
4. UI updates instantly. No network traffic.

### CLI flag opens to focused starting view

1. User runs `code-graph-rag visualize --function handleRequest`.
2. Same boot flow, but `parseUrlFilters()` returns `{ function: 'handleRequest' }` (server passed it via the static page or a query param).
3. `fetchGraph({ function: 'handleRequest' })` → server calls `filterByFunction('handleRequest')` → returns the function(s) + containing file(s) + 1-hop CALLS neighborhood.
4. User opens to a focused starting view they can keep exploring from.

## Error handling & edge cases

| Situation | Behavior |
|---|---|
| Initial fetch returns 0 nodes | `#status`: "No graph data — run `code-graph-rag index` first, then refresh." (existing) |
| `--file <path>` matches nothing | `#status`: "No file matching `<path>`. Try a path relative to repo root." Don't crash. |
| `--function <name>` matches multiple | Show all of them in the initial graph. `#status`: "3 functions named `handleRequest` — pick one to expand." |
| Click-expand returns 0 children | Brief flash on the node + `#status`: "No symbols in this file." `loadedSet` unchanged. |
| Search returns 0 hits | Inline "No matches" below the search box. Loaded graph unchanged. |
| Server fetch fails (network, 500) | `#status`: "Failed to load graph: <reason>   [Retry]". Retry re-runs the last fetch. |
| Rapid double-click on expand | `pendingExpands` set prevents the duplicate request. ~5 lines. |
| Stale data after re-index in another terminal | "Reset everything" button does a full reload. Documented in sidebar: "Run a fresh query if you've re-indexed." |
| Bad `?type=garbage` on /api/expand | Server returns `400 + { error: 'unknown expand type' }`. Client shows in `#status`. |

## Testing approach

### Unit tests (`tests/unit/visualize/queries.test.ts`)

Pure builder tests for `src/visualize/queries.ts`. ~15 tests:
- Each builder returns `{ cypher, params }` of the right shape.
- `params` keys exactly match the `$placeholders` in the cypher string.
- Limit constants are applied as expected.
- Parameters are bound (not interpolated) — no Cypher-injection surface.

No Neo4j needed.

### Integration tests (`tests/integration/visualize/queries.int.test.ts`)

Use the existing Neo4j fixture pattern from `tests/integration/`. Load a small synthetic graph (5 files, 8 functions, 2 classes, a few CALLS / IMPORTS edges), then for each query builder:
- `repoOverview()` returns 1 Repository + 5 Files + 0 functions
- `filterByFile('src/api.ts')` returns the file + its symbols + class methods (assert `:HAS_METHOD` traversal)
- `filterByFunction('handleRequest')` returns function(s) + 1-hop CALLS neighborhood + containing File
- `expandFile(...)` returns the same children as `filterByFile` minus the File itself
- `expandFunction(...)` returns 1-hop only (assert depth — no 2-hop neighbors leak in)
- `searchByName('handle', 10)` returns expected matches, respects limit

### Endpoint tests (`tests/integration/visualize/server.int.test.ts`)

Boot the visualization server against the fixture. Make HTTP requests:

| Request | Expected |
|---|---|
| `GET /api/graph` | 200, nodes + edges arrays |
| `GET /api/graph?repo=...` | 200, filtered correctly |
| `GET /api/graph?file=...` | 200, filtered correctly *(was broken)* |
| `GET /api/graph?function=...` | 200, filtered correctly *(was broken)* |
| `GET /api/expand?type=file&id=...` | 200 |
| `GET /api/expand?type=function&name=...&filePath=...` | 200 |
| `GET /api/search?q=handle` | 200 |
| `GET /api/graph?file=does-not-exist` | 200 with empty nodes (not an error) |
| `GET /api/expand?type=garbage` | 400 with error JSON |

This layer is the regression test for the original bug — there will literally be tests asserting `--file` and `--function` work end-to-end.

### Manual / dogfood test

Run against the `code-graph-rag` repo itself:
1. Default view shows Repository + ~30 files in a readable layout.
2. Click `src/visualize/server.ts` → its functions appear, no overlap.
3. Click `handleRequest` → callers/callees appear.
4. Toggle off "Function" in sidebar → all functions hide instantly (no fetch).
5. Search "neo4j" → matching nodes highlight.
6. "Reset everything" → back to default view.
7. Run the original failing commands: `visualize --file src/api.ts` and `visualize --function handleRequest` — both should now load to a focused starting view.

### No browser test framework

Client-side logic is small enough that the round-trip cost of setting up Playwright/Vitest-browser isn't worth it. Reconsider if `graph.js` grows past ~600 lines.

## README schema fix

Update the schema table at `README.md:151-159` to reflect the actual relationships:

| Relationship | Meaning |
|---|---|
| `(Repository)-[:CONTAINS_FILE]->(File)` | Repo owns file |
| `(File)-[:CONTAINS]->(Function\|Class)` | File contains top-level definition |
| `(Class)-[:HAS_METHOD]->(Function)` | Class method |
| `(Function)-[:CALLS]->(Function)` | Call edge |
| `(File)-[:IMPORTS]->(File)` | Import edge |
| `(File)-[:IMPORTS_SYMBOL]->(Function\|Class)` | Symbol-level import |

## Out of scope (deferred)

- **Migrating off vis-network** to a more capable library (Cytoscape.js, Sigma.js).
- **Live re-indexing** — websocket push of new graph state when files change.
- **Server-side caching** of common queries.
- **Browser test framework** (Playwright/Vitest-browser).
- **Schema-vs-README enforcement test** — it would be valuable to assert that the README schema table matches `CALL db.relationshipTypes()` against a fixture-loaded graph, to prevent the documentation drift we just hit. Worth a follow-up.
- **PageRank-style importance metrics** — current degree-based sizing is sufficient.
