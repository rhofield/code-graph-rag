# Code Graph RAG — Design Spec

A graph-RAG based code indexer that gives AI agents token-efficient code search via an MCP server backed by Neo4j.

## Decisions

| Decision | Choice |
|---|---|
| Language | TypeScript |
| Target codebases | General-purpose, any language, including microservices |
| Retrieval granularity | Multi-level (file → class → function) |
| Agent access | MCP server with tool descriptions as enforcement |
| Re-indexing | Git post-commit hook + on-demand staleness checks at query time |
| Parsing | Tree-sitter with JSON-based language mappings |
| Graph relationships | Containment + calls + imports |
| Neo4j deployment | Docker-managed default, configurable for existing instances |
| Architecture | Separated indexer (write path) + MCP server (read path) |

---

## 1. Graph Model

### Node Types

| Node | Properties | Represents |
|---|---|---|
| `Repository` | `path`, `name`, `lastIndexedAt` | A git repo root |
| `File` | `path`, `relativePath`, `language`, `hash`, `lastModified` | A source file |
| `Module` | `name`, `filePath` | A logical module (Python module, TS/JS module) |
| `Class` | `name`, `startLine`, `endLine`, `docstring` | A class definition |
| `Function` | `name`, `startLine`, `endLine`, `signature`, `docstring`, `snippet` | A function or method |
| `Import` | `source`, `specifiers`, `isDefault` | An import statement |

### Relationships

| Relationship | From → To | Meaning |
|---|---|---|
| `CONTAINS_FILE` | Repository → File | Repo has this file |
| `CONTAINS` | File → Class/Function | File-level containment |
| `HAS_METHOD` | Class → Function | Class contains method |
| `CALLS` | Function → Function | Function calls another function |
| `IMPORTS` | File → File | File imports from another file |
| `IMPORTS_SYMBOL` | File → Function/Class | File imports a specific symbol |
| `DEPENDS_ON` | Repository → Repository | Microservice dependency (for multi-repo) |

### Key Design Decisions

- **`snippet` on Function nodes** — Stores the actual code body. Returned directly to the agent, avoiding filesystem round-trips.
- **`hash` on File nodes** — SHA of file contents. Powers the staleness check: compare stored hash to current file hash.
- **`Repository` as a first-class node** — Enables multi-repo/microservice support. Index several repos and query across them.

### Example Query

```cypher
MATCH (caller:Function)-[:CALLS]->(callee:Function {name: 'validateEmail'})
RETURN caller.name, caller.filePath, caller.snippet
```

---

## 2. CLI & Indexer

The indexer is the write path — it parses code with tree-sitter, extracts the graph structure, and writes it to Neo4j.

### CLI Commands

```bash
# First-time setup — starts Neo4j (Docker), indexes the current repo
code-graph-rag init

# Re-index the current repo (full)
code-graph-rag index

# Re-index only changed files (since last index)
code-graph-rag index --changed

# Re-index a specific file or directory
code-graph-rag index --path src/auth/

# Index a second repo (microservices)
code-graph-rag index --repo /path/to/other/service

# Status — show what's indexed, staleness info
code-graph-rag status

# Install MCP server into Claude Code config
code-graph-rag install-mcp

# Install git post-commit hook into current repo
code-graph-rag install-hook

# Full setup shortcut (init + install-mcp + install-hook)
code-graph-rag setup

# Open browser-based graph visualization
code-graph-rag visualize

# Visualize a specific scope
code-graph-rag visualize --repo myservice
code-graph-rag visualize --file src/auth/login.ts
code-graph-rag visualize --function validateEmail

# Interactive Cypher query REPL
code-graph-rag query

# Run a single Cypher query
code-graph-rag query "MATCH (f:Function {name: 'validateEmail'}) RETURN f"

# Predefined query shortcuts
code-graph-rag query --callers validateEmail
code-graph-rag query --dependencies src/auth/
code-graph-rag query --structure
```

### Indexing Pipeline

```
Source File
    │
    ▼
┌──────────────┐
│  Tree-sitter  │  Parse into syntax tree
│  (per-lang)   │
└──────┬───────┘
       │ AST
       ▼
┌──────────────┐
│  Extractor    │  Single extractor, walks any AST using
│  (generic)    │  node type names from language-map.json
└──────┬───────┘
       │ Graph entities
       ▼
┌──────────────┐
│  Neo4j Writer │  Upsert nodes and relationships
│  (batch)      │  (MERGE, not CREATE — idempotent)
└──────────────┘
```

### Language Support via JSON Mapping

Each language's tree-sitter node type names are declared in `language-map.json`:

```json
{
  "python": {
    "function": ["function_definition"],
    "class": ["class_definition"],
    "import": ["import_from_statement", "import_statement"]
  },
  "typescript": {
    "function": ["function_declaration", "arrow_function", "method_definition"],
    "class": ["class_declaration"],
    "import": ["import_statement"]
  },
  "graphql": {
    "function": ["operation_definition", "fragment_definition"],
    "class": ["object_type_definition", "input_object_type_definition", "interface_type_definition", "enum_type_definition"],
    "import": []
  }
}
```

Initial language support: **TypeScript, TSX, JavaScript, JSX, Python, Go, Java, Rust, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, GraphQL, HTML, CSS, YAML, JSON, SQL, Bash/Shell, Lua, Zig, Elixir, Dart**.

One extractor engine reads this mapping and adapts to any language. Adding a language means adding a few lines to the JSON. A fallback heuristic handles languages without an explicit mapping by searching for common node type patterns.

Note: markup/data languages (HTML, CSS, YAML, JSON) have limited extraction — they get `File` nodes and basic structural elements but no function/class semantics. They are still included so they appear in repo structure and file-level search results.

### Git Post-Commit Hook

Installed by `code-graph-rag install-hook`. Runs after every commit:

```bash
#!/bin/sh
code-graph-rag index --changed &
```

Runs in the background so it doesn't slow down the developer's workflow. The `--changed` flag uses `git diff` internally and filters to supported file extensions based on the language map, so the hook itself doesn't need to hardcode extensions.

### Staleness Detection

When a file is indexed, its content hash is stored on the `File` node. At query time:

1. `stat()` the file to get mtime
2. If mtime > `lastModified` on the node, hash the file
3. If hash differs, trigger `code-graph-rag index --path <file>` for just that file

---

## 3. MCP Server

The read path — tools that AI agents use to search and navigate code.

### MCP Tools

| Tool | Parameters | Returns | Description |
|---|---|---|---|
| `search_code` | `query`, `language?`, `repo?` | Matching functions/classes with snippets | Primary search tool. Full-text search across function names, class names, docstrings, and code content. |
| `get_function` | `name`, `filePath?` | Function node with full snippet | Get a specific function's code. |
| `get_class` | `name`, `filePath?` | Class node with all its methods | Get a class and its methods. |
| `get_file_structure` | `filePath` | List of classes/functions (names, lines, signatures — no bodies) | High-level overview of a file. |
| `get_callers` | `functionName` | Functions that call the target | "Who calls this?" |
| `get_callees` | `functionName` | Functions that the target calls | "What does this call?" |
| `get_dependencies` | `filePath` | Files/modules imported by this file | Import graph for a file. |
| `get_dependents` | `filePath` | Files/modules that import this file | Reverse import graph. |
| `get_repo_structure` | `repo?`, `depth?` | Tree of directories with file counts and top-level symbols | Bird's-eye view of a repo. |
| `reindex` | `path?` | Status message | Trigger re-indexing. |

### Tool Descriptions as Enforcement

MCP tool descriptions guide the agent to prefer graph tools over raw Read/Grep. Example for `search_code`:

> "Search the codebase for functions, classes, and code patterns. This is your PRIMARY code search mechanism — use this instead of Grep or reading entire files. Returns relevant code snippets with file paths and line numbers. Start here when looking for code."

### Staleness Check at Query Time

Every query tool (except `reindex`) runs through this flow:

1. Run the Cypher query against Neo4j
2. For each file in the results, stat() and compare mtime
3. If stale: hash the file, compare to stored hash
4. If hash differs: trigger incremental reindex for that file, re-run the query portion
5. If more than 20 files are stale: return results with a warning instead of triggering a full re-index

### Full-Text Search Implementation

`search_code` uses Neo4j's built-in full-text index. During schema setup, a full-text index is created across `Function.name`, `Function.snippet`, `Function.docstring`, `Class.name`, and `Class.docstring`. This enables Lucene-powered fuzzy and keyword search without an external search engine.

### MCP Server Lifecycle

- Runs as a stdio MCP server — Claude Code starts and manages the process
- Registered via `code-graph-rag install-mcp` or `code-graph-rag setup`
- Connects to Neo4j on startup (configured URI or Docker default)
- Stateless between requests — all state lives in Neo4j

---

## 4. Installation & Distribution

### Package Distribution

Published to npm as `code-graph-rag`:

```bash
npm install -g code-graph-rag
```

Or via npx:

```bash
npx code-graph-rag setup
```

### Setup Flow

```
$ code-graph-rag setup

1. Checking prerequisites...
   ✓ Node.js >= 18
   ✓ Docker available

2. Starting Neo4j...
   ✓ Neo4j container running on bolt://localhost:7687

3. Indexing current repository...
   Parsing files... ████████████████████ 342/342
   Building graph... ████████████████████ done
   ✓ Indexed 342 files, 1,204 functions, 87 classes

4. Installing MCP server into Claude Code...
   ✓ Added to ~/.claude/settings.json

5. Installing git post-commit hook...
   ✓ Hook installed at .git/hooks/post-commit

Ready! Your AI agent now has access to graph-powered code search.
```

### Configuration

Config lives in `.code-graph-rag.json` at the repo root (or `~/.config/code-graph-rag/config.json` for global settings):

```json
{
  "neo4j": {
    "uri": "bolt://localhost:7687",
    "username": "neo4j",
    "password": "code-graph-rag",
    "managed": true
  },
  "index": {
    "include": ["**/*.ts", "**/*.py", "**/*.go"],
    "exclude": ["node_modules", "dist", "vendor", ".git"],
    "languages": "auto"
  },
  "repos": [
    { "path": "/home/user/services/auth", "name": "auth-service" },
    { "path": "/home/user/services/api", "name": "api-gateway" }
  ]
}
```

- `neo4j.managed: true` — tool manages Docker. Set to `false` and change URI to point at an existing instance.
- `index.languages: "auto"` — detects languages from file extensions.
- `repos` array — enables multi-repo/microservice indexing from a single graph.

### Prerequisites

- Node.js >= 18
- Docker (only if using managed Neo4j)
- Git (for the post-commit hook)

---

## 5. Project Structure

```
code-graph-rag/
├── package.json
├── tsconfig.json
├── .code-graph-rag.json
├── docker-compose.yml
│
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/
│   │       ├── setup.ts
│   │       ├── init.ts
│   │       ├── index-cmd.ts
│   │       ├── status.ts
│   │       ├── query.ts
│   │       ├── visualize.ts
│   │       ├── install-mcp.ts
│   │       └── install-hook.ts
│   │
│   ├── indexer/
│   │   ├── index.ts
│   │   ├── parser.ts
│   │   ├── extractor.ts
│   │   ├── language-map.json
│   │   ├── graph-writer.ts
│   │   └── staleness.ts
│   │
│   ├── mcp/
│   │   ├── index.ts
│   │   ├── tools/
│   │   │   ├── search-code.ts
│   │   │   ├── get-function.ts
│   │   │   ├── get-class.ts
│   │   │   ├── get-file-structure.ts
│   │   │   ├── get-callers.ts
│   │   │   ├── get-callees.ts
│   │   │   ├── get-dependencies.ts
│   │   │   ├── get-dependents.ts
│   │   │   ├── get-repo-structure.ts
│   │   │   └── reindex.ts
│   │   └── staleness-check.ts
│   │
│   ├── db/
│   │   ├── connection.ts
│   │   ├── queries.ts
│   │   └── schema.ts
│   │
│   ├── docker/
│   │   └── neo4j.ts
│   │
│   └── visualize/
│       ├── server.ts
│       └── public/
│           ├── index.html
│           └── graph.js
│
├── tests/
│   ├── indexer/
│   ├── mcp/
│   ├── db/
│   └── fixtures/
│       ├── sample.ts
│       ├── sample.py
│       ├── sample.go
│       └── microservices/
│           ├── auth-service/
│           │   ├── src/
│           │   │   ├── index.ts
│           │   │   ├── auth.ts
│           │   │   └── session.ts
│           │   └── package.json
│           ├── api-gateway/
│           │   ├── src/
│           │   │   ├── index.ts
│           │   │   ├── router.ts
│           │   │   └── middleware.ts
│           │   └── package.json
│           └── user-service/
│               ├── src/
│               │   ├── index.ts
│               │   ├── user.ts
│               │   └── profile.ts
│               └── package.json
│
└── bin/
    └── code-graph-rag.js
```

---

## 6. Error Handling & Edge Cases

### Neo4j Unavailable

- MCP tools return a clear error: "Neo4j is not running. Run `code-graph-rag init` to start it."
- CLI commands exit with code 1 and the same message.
- `init` checks if the container exists but is stopped and restarts it.

### Unsupported Languages

- Files without a tree-sitter grammar mapping are skipped during extraction but still get a `File` node (visible in repo structure).
- `status` command shows a count of skipped files.

### Large Repos

- Indexing is batched — files processed in chunks, written to Neo4j in batch transactions.
- First index shows a progress bar.
- `--changed` flag keeps incremental re-indexing fast regardless of repo size.

### Stale Index at Query Time

- Single-file staleness is resolved synchronously (< 1 second).
- If more than 20 files are stale, results are returned with a warning: "Index is stale for N files. Run `code-graph-rag index --changed` for full refresh."

### Deleted Files

- Git post-commit hook detects deleted files and removes their nodes and relationships.
- Staleness check removes `File` nodes whose paths no longer exist on disk.

### Concurrent Access

- Neo4j handles concurrent reads natively.
- Concurrent writes are safe because of `MERGE` operations (idempotent upserts).

### Multi-Repo Conflicts

- File paths are scoped to their `Repository` node via `CONTAINS_FILE`, so same-name files in different repos don't collide.

---

## 7. Testing Strategy

### Unit Tests

- **Extractor tests** — Feed sample source files through the extractor, assert correct nodes and relationships. No Neo4j needed.
- **Staleness tests** — Mock file stat/hash, verify detection logic.
- **Config loading tests** — Verify config merging from defaults, repo config, global config, and env vars.

### Integration Tests

- **Graph writer tests** — Spin up a Neo4j test container, run the indexer against fixtures, query Neo4j to verify the graph.
- **MCP tool tests** — Pre-populate the graph, call each MCP tool, verify response shape and content.
- **Staleness + reindex flow** — Index a fixture, modify a file, call an MCP tool, verify staleness detection and re-indexing.

### Microservice Integration Tests

- **Multi-repo indexing** — Set up fixtures with 2-3 repos simulating microservices. Index all into the same graph. Verify each has its own `Repository` node and `CONTAINS_FILE` relationships don't cross boundaries.
- **Cross-repo dependency queries** — Verify `DEPENDS_ON` relationships between repos work correctly.
- **Cross-repo search** — Call `search_code` without a `repo` filter, verify results from multiple repos. Filter by `repo`, verify scoping.
- **Same filename across repos** — Verify distinct `File` nodes scoped to their respective repositories.
- **Selective reindexing** — Change a file in one microservice, verify only that repo's graph portion is updated.

### End-to-End Tests

- **Full setup flow** — Run `code-graph-rag setup` against a test repo, verify Neo4j starts, graph is populated, MCP config is written, hook is installed.
- **Post-commit hook** — Make a commit in a test repo, verify changed files are re-indexed.

### Test Fixtures

Small source files in multiple languages covering:
- Functions, classes, methods
- Import/export relationships
- Function calls across files
- Edge cases: nested functions, decorators, default exports, anonymous functions

Microservice fixtures:
```
tests/fixtures/microservices/
├── auth-service/     # exports validateToken()
├── api-gateway/      # imports from auth-service
└── user-service/     # calls auth-service's validateToken
```
