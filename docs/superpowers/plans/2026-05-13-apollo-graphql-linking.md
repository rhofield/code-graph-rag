# Apollo GraphQL Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Apollo Client operation usage and Apollo Server resolver links survive real file order, batch order, and multi-repo indexing.

**Architecture:** Extend the existing dependency-free GraphQL detector for Apollo-specific TS/TSX patterns, especially inline `gql` arguments and imported document constants from sibling TS modules. Add a graph-wide GraphQL resolver linker that runs after indexing, matching operation top-level fields to resolver functions after all files in the run have been written.

**Tech Stack:** TypeScript, Vitest, Neo4j Cypher query builders, existing tree-sitter extraction pipeline.

---

### Task 1: Apollo Client Extraction Patterns

**Files:**
- Modify: `tests/fixtures/graphql/frontend-graphql.tsx`
- Create: `tests/fixtures/graphql/apollo-documents.ts`
- Modify: `tests/indexer/extractor.test.ts`
- Modify: `src/indexer/graphql-detector.ts`

- [ ] **Step 1: Write failing extraction tests**

Add fixtures for `useQuery(gql\`...\`)`, `client.query({ query: GET_USER })`, and `import { GET_APOLLO_USER } from "./apollo-documents"`.

- [ ] **Step 2: Run extractor test to verify RED**

Run: `npm test -- --run tests/indexer/extractor.test.ts`

Expected: FAIL because imported TS GraphQL constants and inline `gql` call arguments are not detected.

- [ ] **Step 3: Implement minimal Apollo detector support**

In `src/indexer/graphql-detector.ts`, add parsing for inline `gql`/`graphql` call arguments and imported TS/TSX/JS/JSX GraphQL document constants.

- [ ] **Step 4: Run extractor test to verify GREEN**

Run: `npm test -- --run tests/indexer/extractor.test.ts`

Expected: PASS.

### Task 2: Graph-Wide GraphQL Resolver Linker

**Files:**
- Create: `src/indexer/graphql-linker.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/indexer/index.ts`
- Modify: `src/indexer/workspace.ts`
- Modify: `tests/db/queries.test.ts`
- Modify: `tests/indexer/index.test.ts`

- [ ] **Step 1: Write failing query/linker tests**

Add query-builder coverage for clearing and relinking GraphQL resolver relationships. Add an indexer unit test that proves the GraphQL linker is invoked after repository indexing.

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- --run tests/db/queries.test.ts tests/indexer/index.test.ts`

Expected: FAIL because the graph-wide linker does not exist.

- [ ] **Step 3: Implement graph-wide linker**

Add `linkGraphQLResolverEdges(db, touchedFilePaths)` that clears stale resolver links for touched GraphQL documents and recreates `USES_GRAPHQL_RESOLVER` edges by matching `GraphQLDocument.resolverFieldNames` against `Function.name`.

- [ ] **Step 4: Wire repository and workspace indexing**

Run the linker after RPC linking in `indexRepository`. Run it once more after all repos in `indexWorkspace` to resolve cross-repo ordering.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `npm test -- --run tests/db/queries.test.ts tests/indexer/index.test.ts`

Expected: PASS.

### Task 3: Final Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- --run tests/indexer/extractor.test.ts tests/db/queries.test.ts tests/indexer/index.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run: `npm test -- --run`

Expected: PASS, with integration tests skipped unless `INTEGRATION=1`.

- [ ] **Step 3: Run typecheck**

Run: `npm run lint`

Expected: PASS.
