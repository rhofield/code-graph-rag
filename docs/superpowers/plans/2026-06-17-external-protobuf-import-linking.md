# External Protobuf Import Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link TypeScript graph-layer protobuf/Connect imports from `node_modules` to canonical `.proto` definitions and avoid dead-end caller results at generated Go protobuf dispatchers.

**Architecture:** Extend the existing `ProtoRegistry` and RPC detector instead of indexing `node_modules`. TypeScript import sources are resolved to registry package/service candidates, resolver functions get `USES_PROTO`/RPC annotations against canonical `ProtoMethod` nodes, and caller queries traverse canonical proto peers when a target is a generated dispatcher.

**Tech Stack:** TypeScript, web-tree-sitter, Neo4j Cypher, Vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/indexer/proto-registry.ts` | Add package/service/message lookup helpers used by import-path resolution. |
| `src/indexer/rpc-detector.ts` | Resolve external `@buf`/Connect imports to canonical proto methods and services. |
| `src/db/queries.ts` | Expand caller traversal through proto peers and generated dispatcher targets. |
| `tests/indexer/rpc-detector.test.ts` | Unit coverage for external Connect service imports from `node_modules`. |
| `tests/db/queries.test.ts` | Query text coverage for generated-dispatcher/proto traversal. |

### Task 1: Registry Lookup Helpers

- [ ] Write failing unit expectations for package/service lookups in `tests/indexer/proto-registry.test.ts`.
- [ ] Run `npm test -- tests/indexer/proto-registry.test.ts` and confirm the helper methods are missing.
- [ ] Add lookup helpers to `src/indexer/proto-registry.ts`.
- [ ] Re-run the proto registry tests.

### Task 2: External TypeScript Import Resolution

- [ ] Add a failing detector test where a resolver imports `UserService` from `@buf/example_user.connect`, creates a Connect promise client, and calls `client.getUser(...)`.
- [ ] Run `npm test -- tests/indexer/rpc-detector.test.ts` and confirm the resolver call is not annotated.
- [ ] Update `src/indexer/rpc-detector.ts` so imported Connect service symbols bind client variables to service names.
- [ ] Re-run `tests/indexer/rpc-detector.test.ts`.

### Task 3: Caller Query Generated Dispatcher Collapse

- [ ] Add a failing query test asserting `functionCallersQuery` includes a proto-peer/GraphQL traversal for generated dispatcher targets.
- [ ] Run `npm test -- tests/db/queries.test.ts` and confirm the expected Cypher fragment is absent.
- [ ] Update `src/db/queries.ts` to traverse from a target function's `USES_PROTO` method to resolver/front-end callers and to filter or de-prioritize generated protobuf callers.
- [ ] Re-run `tests/db/queries.test.ts`.

### Task 4: Focused Verification

- [ ] Run `npm test -- tests/indexer/proto-registry.test.ts tests/indexer/rpc-detector.test.ts tests/db/queries.test.ts`.
- [ ] Run any existing GraphQL/RPC integration tests that do not require external services.
- [ ] Inspect `git diff` for unrelated changes before final response.
