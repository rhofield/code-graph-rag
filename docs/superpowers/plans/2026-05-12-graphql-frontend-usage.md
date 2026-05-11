# GraphQL Frontend Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graph extraction and persistence for frontend GraphQL operation and fragment usage in `.ts`, `.tsx`, `.graphql`, and `.gql` files.

**Architecture:** Add a small dependency-free GraphQL document detector and integrate it into the existing extractor. Persist `GraphQLDocument` nodes in the graph writer and batch writer, then link frontend functions to used documents and documents to spread fragments with new Cypher query builders.

**Tech Stack:** TypeScript, web-tree-sitter, Neo4j Cypher query builders, Vitest.

---

### Task 1: Extraction Tests And Detector

**Files:**
- Create: `tests/fixtures/graphql/UserFields.graphql`
- Create: `tests/fixtures/graphql/frontend-graphql.tsx`
- Modify: `tests/indexer/extractor.test.ts`
- Create: `src/indexer/graphql-detector.ts`
- Modify: `src/indexer/extractor.ts`

- [ ] **Step 1: Write failing tests**

Add tests that assert extracted GraphQL documents include `GetUser`, `UpdateUser`, `UserFields`, and `AvatarFields`, and that frontend functions using document variables produce `graphqlUsages`. Assert `GetUser -> UserFields` and `UserFields -> AvatarFields` fragment spread relationships.

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/indexer/extractor.test.ts`

Expected: FAIL because `GraphEntities` has no GraphQL document or usage fields yet.

- [ ] **Step 3: Implement detector and wire extractor**

Add `parseGraphQLDocuments`, `extractGraphQLFromSource`, and TS/TSX usage detection. Keep the parser scoped to named operation definitions, named fragment definitions, and named fragment spreads.

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/indexer/extractor.test.ts`

Expected: PASS.

### Task 2: Persistence Query Builders

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `tests/db/queries.test.ts`

- [ ] **Step 1: Write failing query-builder tests**

Add tests for `batchUpsertGraphQLDocuments`, `batchUpsertGraphQLUsages`, and `batchUpsertGraphQLFragmentSpreads`.

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/db/queries.test.ts`

Expected: FAIL because the query builders do not exist.

- [ ] **Step 3: Implement query builders**

Create Cypher that merges `GraphQLDocument` nodes, optionally links them from `File`, links `Function` to `GraphQLDocument` with `USES_GRAPHQL`, and links documents to fragments with `USES_FRAGMENT`.

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/db/queries.test.ts`

Expected: PASS.

### Task 3: Writers And Pipeline

**Files:**
- Modify: `src/indexer/graph-writer.ts`
- Modify: `src/indexer/batch-writer.ts`
- Modify: `src/indexer/parallel-pipeline.ts`
- Modify: `src/indexer/index.ts`
- Modify: `tests/indexer/graph-writer.test.ts`
- Modify: `tests/indexer/parallel-pipeline.test.ts`

- [ ] **Step 1: Write failing writer tests**

Assert `writeGraphEntities` writes document, usage, and fragment-spread queries. Update pipeline tests so empty fixture entity objects include the new GraphQL arrays.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/indexer/graph-writer.test.ts tests/indexer/parallel-pipeline.test.ts`

Expected: FAIL because writers ignore the new entity fields.

- [ ] **Step 3: Implement writer and batch writer support**

Buffer and upsert GraphQL documents alongside functions/classes. Link GraphQL usages and fragment spreads after documents are written.

- [ ] **Step 4: Run writer tests to verify pass**

Run: `npm test -- tests/indexer/graph-writer.test.ts tests/indexer/parallel-pipeline.test.ts`

Expected: PASS.

### Task 4: Final Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run focused test suite**

Run: `npm test -- tests/indexer/extractor.test.ts tests/db/queries.test.ts tests/indexer/graph-writer.test.ts tests/indexer/parallel-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run lint`

Expected: PASS.
