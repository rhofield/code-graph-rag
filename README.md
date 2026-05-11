# rho-graph

> Graph-RAG code indexer for AI agents — token-efficient code search via MCP tools backed by Neo4j

Parses your codebase into a knowledge graph (functions, classes, imports, call edges) and exposes it as MCP tools that Claude Code, Cursor, and other AI agents can use instead of reading raw files. A graph traversal to find callers of a function costs a handful of tokens; reading every file to find the same thing costs thousands.

---

## How it works

```
Your code
    │
    ▼ tree-sitter (WASM, no native deps)
Parse AST
    │
    ▼ extractor
Functions · Classes · Imports · Call edges
    │
    ▼ graph-writer
Neo4j property graph
    │
    ▼ MCP server (stdio)
Claude Code / Cursor get 10 graph tools
```

Files are parsed with [tree-sitter](https://tree-sitter.github.io/) via WASM bindings — no native compilation required. The resulting entities are written to Neo4j with uniqueness constraints and full-text indexes so queries are fast even on large repos.

Incremental indexing checks files against stored content hashes and mtimes so only changed files are re-parsed on subsequent runs.

---

## Supported languages

TypeScript · TSX · JavaScript · Python · Go · Java · Rust · C · C++ · Ruby · GraphQL · YAML · JSON · Markdown

---

## Quick start

```bash
# Install globally
npm install -g rho-graph

# In your repo: start Neo4j, index, register MCP, install git hook
rho-graph setup
```

That's it. Claude Code and Cursor will now have access to the graph tools for the current repo.

**Prerequisites:** Docker (for the managed Neo4j instance) and Node.js >= 18.

---

<<<<<<< HEAD
## Multi-repo root (microservices)

If you run `rho-graph init` or `index` from a directory that is not itself a git repo but contains microservice repos as subdirectories, rho-graph walks the tree to find them (any dir containing `.git/` is treated as a repo; walk stops at found repos and at `index.exclude` dirs like `node_modules`). The discovered list is written to `.rho-graph.json` and refreshed every 24h (configurable via `discovery.ttlHours`).

Force a refresh manually:

```bash
rho-graph discover            # walks and updates .rho-graph.json
rho-graph discover --dry-run  # preview changes, write nothing
```

---

=======
>>>>>>> origin/main
## CLI reference

| Command | Description |
|---|---|
| `setup` | One-shot: runs `init` + `install-mcp` + `install-hook` |
| `init` | Start Neo4j (Docker) and index the current repo |
| `index [path]` | Re-index (full or `--changed` for incremental) |
| `status` | Show graph stats: repos, files by language, function/class counts |
| `install-mcp` | Register the MCP server in `~/.claude/settings.json` and `~/.cursor/mcp.json` |
| `install-hook` | Install `.git/hooks/post-commit` to auto-reindex on commit |
| `query [cypher]` | Run a Cypher query or open an interactive REPL |
| `visualize` | Open a browser-based graph visualization on port 3333 |
| `mcp-serve` | Start the MCP server (called automatically by Claude Code / Cursor) |

### `index` options

```bash
rho-graph index              # full reindex
rho-graph index --changed    # only files changed since last index
rho-graph index src/auth     # index a subtree
```

### `query` examples

```bash
# Shorthand flags
rho-graph query --callers processPayment
rho-graph query --dependencies src/auth/middleware.ts
rho-graph query --structure

# Raw Cypher
rho-graph query "MATCH (f:Function) WHERE f.name STARTS WITH 'get' RETURN f.name, f.filePath LIMIT 20"

# Interactive REPL
rho-graph query
cypher> MATCH (c:Class)-[:CONTAINS]->(f:Function) RETURN c.name, count(f) ORDER BY count(f) DESC
```

### `visualize` options

```bash
rho-graph visualize                     # full graph
rho-graph visualize --repo my-service   # filter by repo
rho-graph visualize --file src/api.ts   # focus on a file
rho-graph visualize --function handleRequest
rho-graph visualize --port 4000
```

---

## MCP tools

Once installed, Claude Code and Cursor have access to these tools. They are designed to be used instead of reading source files.

| Tool | What it does |
|---|---|
| `search_code` | Full-text search across function/class names, signatures, and code snippets |
| `get_function` | Retrieve a function's source, signature, file, and line range |
| `get_class` | Retrieve a class definition and its members |
| `get_file_structure` | List all functions and classes defined in a file |
| `get_callers` | Find every function that calls a given function |
| `get_callees` | Find every function called by a given function |
| `get_dependencies` | Files imported by a given file |
| `get_dependents` | Files that import a given file |
| `get_repo_structure` | High-level view: repos, files per language |
| `reindex` | Trigger incremental reindex from within a conversation |

### Example agent workflow

```
Agent: search_code("authentication middleware")
→ finds handleAuth in src/auth/middleware.ts

Agent: get_callers("handleAuth")
→ finds 3 routes that depend on it

Agent: get_function("handleAuth", "src/auth/middleware.ts")
→ retrieves the full source + signature

Agent: get_dependencies("src/auth/middleware.ts")
→ finds what it imports, traces the dependency chain
```

---

## Graph schema

**Nodes**

| Label | Key properties |
|---|---|
| `Repository` | `path`, `name`, `lastIndexedAt` |
| `File` | `path`, `relativePath`, `language`, `hash`, `lastModified` |
| `Function` | `name`, `filePath`, `signature`, `snippet`, `startLine`, `endLine` |
| `Class` | `name`, `filePath`, `snippet`, `startLine`, `endLine` |

**Relationships**

| Relationship | Meaning |
|---|---|
| `(Repository)-[:CONTAINS_FILE]->(File)` | Repo owns file |
| `(File)-[:CONTAINS]->(Function\|Class)` | File contains top-level definition |
| `(Class)-[:HAS_METHOD]->(Function)` | Class method |
| `(Function)-[:CALLS]->(Function)` | Call edge |
| `(File)-[:IMPORTS]->(File)` | Import edge |
| `(File)-[:IMPORTS_SYMBOL]->(Function\|Class)` | Symbol-level import |

**Indexes**

- Uniqueness constraints on `Repository.path` and `File.path`
- B-tree indexes on `Function.name`, `Class.name`, `File.language`
- Full-text index (`code_search`) on `Function.name`, `Function.snippet`, `Function.docstring`, `Class.name`, `Class.snippet`, `Class.docstring`

---

## Configuration

Config is resolved in this order (later values win):

1. Built-in defaults
2. `~/.config/rho-graph/config.json` (global)
3. `.rho-graph.json` in the repo root (per-repo)
4. Environment variables

### Full config reference

```json
{
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "username": "neo4j",
    "password": "rho-graph",
    "managed": true
  },
  "index": {
    "include": ["**/*"],
    "exclude": ["node_modules", "dist", "vendor", ".git", "build", "__pycache__"],
    "languages": "auto"
  },
<<<<<<< HEAD
  "repos": [],
  "discovery": {
    "ttlHours": 24,
    "maxDepth": 6
  }
=======
  "repos": []
>>>>>>> origin/main
}
```

`managed: true` means Neo4j is started automatically via Docker Compose. Set to `false` to connect to an existing instance.

<<<<<<< HEAD
`discovery` controls the multi-repo walk (see [Multi-repo root](#multi-repo-root-microservices)). `repos` and `lastDiscoveredAt` are managed by `rho-graph discover`; you can pre-seed `repos` manually if you want to override the auto-walk.

=======
>>>>>>> origin/main
### Environment variable overrides

```bash
NEO4J_URI=bolt://my-server:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=secret
```

### Per-repo config example

```json
{
  "index": {
    "include": ["src/**/*", "lib/**/*"],
    "exclude": ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"]
  }
}
```

---

## Bring your own Neo4j

If you already have Neo4j running (local, Aura, Docker Compose, etc.):

```json
{
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "username": "neo4j",
    "password": "your-password",
    "managed": false
  }
}
```

The Docker Compose file is included in the package if you want to run it manually:

```bash
docker compose -f node_modules/rho-graph/docker-compose.yml up -d
```

---

## Automatic reindexing

The `install-hook` command writes a `post-commit` git hook that runs `rho-graph index --changed` in the background after every commit. Only files that changed (by content hash) are re-parsed, so the overhead is minimal.

If you already have a `post-commit` hook, the command appends to it rather than replacing it.

---

## Development

```bash
git clone https://github.com/rhofield/rho-graph
cd rho-graph
npm install

# Start Neo4j
docker compose up -d

# Build
npm run build

# Watch mode
npm run dev

# Tests
npm test

# Type check
npm run lint
```

## License

MIT
