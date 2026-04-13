# gRPC/Protobuf Cross-Service Linking

**Date:** 2026-04-13
**Status:** Approved

## Problem

rho-graph cannot determine relationships between RPC calls across different microservices using protobufs. When Service A calls Service B's `GetUser` RPC via a generated gRPC stub, the indexer sees a call to `userServiceClient.GetUser(...)` but has no knowledge that this maps to the `GetUser` RPC defined in a `.proto` file, or to the handler function implementing it in Service B.

## Approach

In-memory `ProtoRegistry` populated at index time + per-language structural heuristics for handler/caller detection + stateless Neo4j-based linking.

Chosen over two alternatives:
- **Proto metadata as intermediate Neo4j nodes** — rejected because it adds schema complexity and the user wants clean function-to-function edges
- **Language-specific extractor plugins** — rejected as over-engineered; the structural heuristics are uniform enough across languages to share a single detection module

## Architecture

```
.proto files --> ProtoParser --> ProtoRegistry (in-memory)
                                       |
source files --> (existing pipeline) --> RpcDetector --> Function nodes tagged with rpcRole/rpcService/rpcMethod
                       |                                       |
                       v                                       v
                  Neo4j (Function/Class nodes)          RpcLinker
                                                             |
                                                             v
                                              Neo4j: Function -[RPC_CALLS]-> Function
```

### New Modules

| File | Purpose |
|---|---|
| `src/indexer/proto-registry.ts` | Stores parsed service/RPC definitions; shareable across repos |
| `src/indexer/proto-parser.ts` | Regex-parses `.proto` files, populates `ProtoRegistry` |
| `src/indexer/rpc-detector.ts` | AST-based per-language detection of gRPC handlers and callers |
| `src/indexer/rpc-linker.ts` | Stateless Cypher query to write `RPC_CALLS` edges from tagged Function nodes |

### Changes to Existing Modules

| File | Change |
|---|---|
| `src/indexer/index.ts` | Split files into proto/source, pre-process protos first, run linker last, accept optional `protoRegistry` in options |
| `src/indexer/parser.ts` | Add `.proto` to `EXTENSION_MAP` |
| `src/indexer/batch-writer.ts` | Accept optional RPC annotations, set `rpcRole`/`rpcService`/`rpcMethod` on Function nodes |
| `src/db/queries.ts` | Add `upsertFunctionWithRpcMeta` and `resolveRpcEdges` |

## ProtoRegistry

```typescript
interface ProtoRpcDef {
  serviceName: string;    // "UserService"
  methodName: string;     // "GetUser" (PascalCase, as in .proto)
  methodCamel: string;    // "getUser" (for TS/Java generated stubs)
  requestType: string;    // "GetUserRequest"
  responseType: string;   // "GetUserResponse"
  packageName: string;    // "user.v1"
  protoFile: string;      // absolute path to the .proto file
}

class ProtoRegistry {
  register(def: ProtoRpcDef): void
  lookup(serviceName: string, methodName: string): ProtoRpcDef | null
  lookupByMethod(methodName: string): ProtoRpcDef[]
  getServiceMethods(serviceName: string): ProtoRpcDef[]
}
```

Shared across `indexRepository` calls via an optional `protoRegistry` parameter:

```typescript
const registry = createProtoRegistry();
await indexRepository(db, protoRepo, config, { protoRegistry: registry });
await indexRepository(db, serviceA, config, { protoRegistry: registry });
await indexRepository(db, serviceB, config, { protoRegistry: registry });
```

## Proto Parser

Regex-based. No tree-sitter grammar exists in `tree-sitter-wasms` for proto. The relevant syntax is minimal:

1. `package\s+([\w.]+)\s*;` -- package name
2. `service\s+(\w+)\s*\{` -- service name + block delimiter
3. `rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)` -- method name, request, response types

Proto files are always parsed during indexing (even under `changedOnly`) since they are typically small and few.

## RPC Detection: Per-Language Structural Heuristics

Detection is a two-step filter per source file.

### Step 1: Gate Check (import detection)

Does the file import gRPC-generated code? If not, skip.

| Language | Import pattern |
|---|---|
| Go | Import path ending in `pb`, `proto`, or matching `*/<service>/v*` |
| Python | Import of `*_pb2_grpc` module |
| TypeScript | Import from `*_grpc_pb`, `*ServiceClient`, or `@grpc/*` generated paths |
| Java | Import of `*Grpc` or `*ServiceGrpc` class |

### Step 2: Handler Detection (structural heuristics)

| Language | Handler signal | AST extraction |
|---|---|---|
| Go | Method declaration where receiver type name contains a known service name + ends with `Server` | `method_declaration` -> `receiver` field -> type name |
| Python | Method on a class whose base class list includes `*Servicer` | `class_definition` -> `argument_list` (bases) -> check for `*Servicer` |
| TypeScript | Method on a class that `implements *Server` or function assigned in `server.addService(...)` | `class_declaration` -> `implements_clause` |
| Java | Method on a class that `extends *ImplBase` | `class_declaration` -> `superclass` -> check for `*ImplBase` |

### Step 2b: Caller Detection

| Language | Call pattern | Method name casing |
|---|---|---|
| Go | `something.GetUser(ctx, req)` | PascalCase (same as proto) |
| Python | `stub.GetUser(request)` | PascalCase (same as proto) |
| TypeScript | `client.getUser(req, callback)` | camelCase |
| Java | `stub.getUser(req)` | camelCase |

Detected callers and handlers are tagged on Function nodes in Neo4j with properties: `rpcRole` ("caller" or "handler"), `rpcService`, `rpcMethod`.

## RPC Linker

Stateless Cypher query that runs after all files in a repository are indexed:

```cypher
MATCH (caller:Function {rpcRole: "caller"})
MATCH (handler:Function {rpcRole: "handler"})
WHERE caller.rpcService = handler.rpcService
  AND caller.rpcMethod = handler.rpcMethod
MERGE (caller)-[r:RPC_CALLS]->(handler)
SET r.serviceName = caller.rpcService, r.methodName = caller.rpcMethod
```

This matches against ALL tagged functions in the entire graph, not just the current indexing run. This makes cross-repo linking work regardless of indexing order -- the last repo indexed resolves all edges.

Batched via `UNWIND` for efficiency. Idempotent via `MERGE`.

## Pipeline Integration

```
indexRepository(db, repoPath, config, options)
|
+-- 1. discoverFiles()                          [existing]
+-- 2. Separate into protoFiles / sourceFiles   [NEW]
+-- 3. Parse protoFiles -> populate registry     [NEW]
+-- 4. Filter sourceFiles by language/staleness  [existing]
+-- 5. Run parallel pipeline on sourceFiles      [existing, with RPC detection added]
|   +-- For each file:
|       +-- parseFile -> extractGraphEntities    [existing]
|       +-- rpcDetector.detect(tree, language, source, filePath, registry)  [NEW]
|       +-- batchWriter.add(entities, meta, rpcAnnotations)  [modified]
+-- 6. rpcLinker.link(db)                        [NEW]
+-- 7. Orphan cleanup                            [existing]
+-- 8. Commit SHA update                         [existing]
```

`IndexResult` extended with `rpcEdgesCreated: number`.

## Supported Languages

Go, Python, TypeScript/Node, Java -- all four from initial release.

## Testing

### Unit Tests (no Neo4j)

| Test file | Coverage |
|---|---|
| `tests/indexer/proto-parser.test.ts` | Regex parsing of `.proto` files: single service, multiple services, comments, edge cases |
| `tests/indexer/proto-registry.test.ts` | Registry lookup by (service, method), `lookupByMethod` fallback, camelCase resolution |
| `tests/indexer/rpc-detector.test.ts` | Per-language detection using fixture files: Go, Python, TS, Java handlers and callers |

### Test Fixtures

```
tests/fixtures/grpc/
+-- monorepo/                         # Everything in one repo
|   +-- proto/user.proto
|   +-- user-service/src/handler.go
|   +-- auth-service/src/caller.py
|
+-- multirepo/                        # Proto repo separate from services
    +-- proto-repo/
    |   +-- user/v1/user.proto
    +-- service-a/src/caller.ts       # calls GetUser
    +-- service-b/src/handler.java    # implements GetUser
```

Mono-repo uses Go handler + Python caller. Multi-repo uses Java handler + TypeScript caller. All four languages are exercised across the two topologies.

### Integration Tests (requires Neo4j)

| Test | Topology | Assertion |
|---|---|---|
| Single indexRepository call resolves cross-service RPC edges | monorepo | `RPC_CALLS` edge between caller.py::fetchUser -> handler.go::GetUser |
| No false positives for non-gRPC functions with matching names | monorepo | Plain `GetUser` helper (no gRPC imports) has no `RPC_CALLS` edge |
| Proto repo indexed first, then services | multirepo (3 separate indexRepository calls, shared registry) | `RPC_CALLS` edge between caller.ts::loadUser -> handler.java::getUser |
| Services indexed in any order still resolves | multirepo (index service-a before service-b) | After service-b is indexed, edge from service-a caller to service-b handler exists |
| Re-index single service preserves cross-repo edges | multirepo (full index, then re-index only service-a) | Existing `RPC_CALLS` edges to service-b handlers survive |
| Shared registry persists across calls | multirepo | Registry populated by proto-repo is usable when indexing service-a and service-b |
| Multiple RPCs on same service resolve independently | both | `GetUser` and `CreateUser` produce distinct `RPC_CALLS` edges to correct handlers |
| Handler removal cleans up edges | both (re-index after removing a handler) | `RPC_CALLS` edge to that handler is gone |
