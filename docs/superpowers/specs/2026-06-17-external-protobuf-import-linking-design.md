# External Protobuf Import Linking

**Date:** 2026-06-17
**Status:** Approved

## Problem

Production graph-layer TypeScript imports generated protobuf and Connect packages from `node_modules`, while backend services use Go generated protobuf files. The indexer does not crawl `node_modules`, so TypeScript generated files cannot be used as bridge nodes. Caller queries can therefore stop at generated Go protobuf dispatchers or helpers instead of reaching the GraphQL resolver and frontend caller.

## Design

The `.proto` registry remains the canonical cross-language identity. Generated artifacts are treated as aliases to `ProtoMethod` and `ProtoMessage` nodes, never as the source of truth.

TypeScript detection resolves external generated imports directly against `ProtoRegistry`:

- `@buf/.../user/v1/user_pb` maps to package-like path candidates such as `user.v1`.
- `@buf/.../user.connect` plus imported service names maps to service definitions already parsed from `.proto`.
- Named message imports map to `ProtoMessage`; request/response imports map to the corresponding `ProtoMethod` only when unambiguous.
- Connect clients created with `createPromiseClient(UserService, ...)` allow `client.getUser(...)` calls to map to `UserService/GetUser`.

Caller queries should collapse generated protobuf dispatchers. Generated functions may still be indexed, but `get_callers` should also return semantic callers connected through the same canonical proto method, including GraphQL resolver and frontend usage paths.

## Scope

This change does not index `node_modules`. It adds import-path/package inference and query traversal through existing `ProtoMethod`, `ProtoMessage`, `USES_PROTO`, `RPC_CALLS`, `USES_GRAPHQL`, and `USES_GRAPHQL_RESOLVER` relationships.

## Testing

Tests should cover a production-shaped case where:

- TS imports generated protobuf or Connect packages from `@buf/...` with no generated TS files indexed.
- A Go generated dispatcher calls the real backend handler.
- Querying callers of the backend handler or generated dispatcher can surface the GraphQL resolver/frontend caller through canonical proto edges.
