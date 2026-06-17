// tests/db/queries.test.ts
import { describe, it, expect } from "vitest";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
  upsertImportRelationship,
  batchUpsertProtoUsageRelationships,
  deleteFileAndRelationships,
  upsertRepositoryWithCommit,
  getRepositoryCommit,
  deleteRepositoryAndFiles,
  batchUpsertGraphQLDocuments,
  batchUpsertGraphQLUsages,
  batchUpsertGraphQLFragmentSpreads,
  batchUpsertGraphQLResolverLinks,
  clearGraphQLResolverLinks,
  resolveGraphQLResolverLinks,
  functionCallersQuery,
} from "../../src/db/queries.js";

describe("query builders", () => {
  it("upsertRepository returns valid cypher and params", () => {
    const { cypher, params } = upsertRepository({
      path: "/home/user/project",
      name: "project",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Repository");
    expect(params.path).toBe("/home/user/project");
    expect(params.name).toBe("project");
  });

  it("upsertFile returns valid cypher and params", () => {
    const { cypher, params } = upsertFile({
      path: "/home/user/project/src/index.ts",
      relativePath: "src/index.ts",
      repoPath: "/home/user/project",
      language: "typescript",
      hash: "abc123",
      lastModified: 1700000000,
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":File");
    expect(cypher).toContain("CONTAINS_FILE");
    expect(params.path).toBe("/home/user/project/src/index.ts");
  });

  it("upsertFunction returns valid cypher and params", () => {
    const { cypher, params } = upsertFunction({
      name: "greet",
      filePath: "/home/user/project/src/index.ts",
      startLine: 1,
      endLine: 5,
      signature: "function greet(name: string): string",
      docstring: null,
      snippet: "function greet(name: string): string {\n  return `Hello ${name}`;\n}",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Function");
    expect(cypher).toContain("CONTAINS");
    expect(params.name).toBe("greet");
  });

  it("upsertClass returns valid cypher and params", () => {
    const { cypher, params } = upsertClass({
      name: "UserService",
      filePath: "/home/user/project/src/user.ts",
      startLine: 1,
      endLine: 20,
      docstring: "Handles user operations",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Class");
    expect(params.name).toBe("UserService");
  });

  it("upsertCallRelationship returns valid cypher", () => {
    const { cypher, params } = upsertCallRelationship({
      callerName: "handleRequest",
      callerFilePath: "/home/user/project/src/router.ts",
      calleeName: "validateToken",
    });
    expect(cypher).toContain("CALLS");
    expect(params.callerName).toBe("handleRequest");
    expect(params.calleeName).toBe("validateToken");
  });

  it("upsertImportRelationship returns valid cypher", () => {
    const { cypher, params } = upsertImportRelationship({
      sourceFilePath: "/home/user/project/src/router.ts",
      targetFilePath: "/home/user/project/src/auth.ts",
    });
    expect(cypher).toContain("IMPORTS");
    expect(params.sourceFilePath).toBe("/home/user/project/src/router.ts");
  });

  it("batchUpsertProtoUsageRelationships links functions to ProtoMethod nodes", () => {
    const { cypher, params } = batchUpsertProtoUsageRelationships([
      {
        functionName: "user",
        filePath: "/repo/resolvers.ts",
        serviceName: "UserService",
        methodName: "GetUser",
        role: "consumer",
      },
    ]);

    expect(cypher).toContain("ProtoMethod");
    expect(cypher).toContain("USES_PROTO");
    expect(params.items).toHaveLength(1);
  });

  it("deleteFileAndRelationships returns valid cypher", () => {
    const { cypher, params } = deleteFileAndRelationships({
      filePath: "/home/user/project/src/old.ts",
    });
    expect(cypher).toContain("DETACH DELETE");
    expect(params.filePath).toBe("/home/user/project/src/old.ts");
  });

  it("upsertRepositoryWithCommit includes lastIndexedCommit", () => {
    const { cypher, params } = upsertRepositoryWithCommit({
      path: "/project",
      name: "project",
      lastIndexedCommit: "abc123def",
    });
    expect(cypher).toContain("lastIndexedCommit");
    expect(params.lastIndexedCommit).toBe("abc123def");
  });

  it("getRepositoryCommit returns query for lastIndexedCommit", () => {
    const { cypher, params } = getRepositoryCommit({ path: "/project" });
    expect(cypher).toContain("lastIndexedCommit");
    expect(params.path).toBe("/project");
  });

  it("functionCallersQuery includes proto peers that share a ProtoMethod", () => {
    const { cypher, params } = functionCallersQuery({
      functionName: "GetUser",
      filePath: "/repo/service/handler.go",
    });

    expect(cypher).toContain("CALLS|RPC_CALLS");
    expect(cypher).toContain("USES_PROTO");
    expect(cypher).toContain("ProtoMethod");
    expect(cypher).toContain("USES_GRAPHQL_RESOLVER");
    expect(cypher).toContain("USES_GRAPHQL");
    expect(cypher).toContain("graphqlDocument");
    expect(cypher).toContain("graphqlResolver");
    expect(cypher).toContain("peerUse.role");
    expect(cypher).toContain('peerUse.role IN ["consumer", "caller"]');
    expect(cypher).toContain('resolverUse.role IN ["consumer", "caller"]');
    expect(params).toEqual({
      functionName: "GetUser",
      filePath: "/repo/service/handler.go",
    });
  });

  it("functionCallersQuery traverses from generated proto dispatcher targets to GraphQL resolvers first", () => {
    const { cypher } = functionCallersQuery({
      functionName: "_UserService_GetUser_Handler",
      filePath: "/repo/gen/users_grpc.pb.go",
    });

    expect(cypher).toContain("dispatcherUse.role IN");
    expect(cypher).toContain("USES_GRAPHQL_PROTO_DISPATCHER");
    expect(cypher).toContain('resolverUse.role IN ["consumer", "caller"]');
    expect(cypher).toContain("generated proto dispatcher");
    expect(cypher).toContain('"USES_GRAPHQL_PROTO_DISPATCHER" AS callType');
    expect(cypher).toContain("RETURN resolver AS caller");
  });

  it("functionCallersQuery filters generated protobuf callers from direct call results", () => {
    const { cypher } = functionCallersQuery({
      functionName: "GetUser",
      filePath: "/repo/service/handler.go",
    });

    expect(cypher).toContain("isGeneratedProtoCaller");
    expect(cypher).toContain("generated.pb.go");
    expect(cypher).toContain('coalesce(caller.filePath, "") ENDS WITH ".pb.go"');
    expect(cypher).toContain('coalesce(caller.filePath, "") ENDS WITH "_pb.ts"');
    expect(cypher).toContain("NOT isGeneratedProtoCaller");
  });

  it("functionCallersQuery collapses generated proto callers of a real handler through the canonical proto method", () => {
    const { cypher } = functionCallersQuery({
      functionName: "GetUser",
      filePath: "/repo/service/handler.go",
    });

    expect(cypher).toContain("generated proto caller bridge");
    expect(cypher).toContain("generatedCaller");
    expect(cypher).toContain("generatedUse.role IN");
    expect(cypher).toContain("USES_GRAPHQL_PROTO_GENERATED_CALLER");
    expect(cypher).toContain('"USES_GRAPHQL_PROTO_GENERATED_CALLER" AS callType');
    expect(cypher).toContain("RETURN resolver AS caller");
  });

  it("functionCallersQuery returns the canonical proto method as a bridge caller", () => {
    const { cypher } = functionCallersQuery({
      functionName: "GetUser",
      filePath: "/repo/service/handler.go",
    });

    expect(cypher).toContain("PROTO_CANONICAL");
    expect(cypher).toContain("proto.serviceName + \".\" + proto.methodName");
    expect(cypher).toContain("proto.protoFile");
  });

  it("functionCallersQuery can target a canonical proto method and return graph-layer proto users", () => {
    const { cypher, params } = functionCallersQuery({
      functionName: "UserService.GetUser",
    });

    expect(cypher).toContain("target:ProtoMethod");
    expect(cypher).toContain('target.serviceName + "." + target.methodName = $functionName');
    expect(cypher).toContain("target.protoFile = $functionName");
    expect(cypher).toContain("proto target: graph-layer functions that call or consume the canonical proto");
    expect(cypher).toContain("MATCH (caller:Function)-[protoUse:USES_PROTO]->(target)");
    expect(cypher).toContain('protoUse.role IN ["consumer", "caller"]');
    expect(cypher).toContain("NOT isGeneratedProtoCaller");
    expect(params).toEqual({
      functionName: "UserService.GetUser",
      filePath: null,
    });
  });

  it("functionCallersQuery can return only lean human-facing caller columns", () => {
    const { cypher, params } = functionCallersQuery({
      functionName: "GetUser",
      verbose: false,
    });

    expect(cypher).toContain("caller.name AS caller");
    expect(cypher).toContain("caller.filePath AS file");
    const outputClause = cypher.slice(cypher.lastIndexOf("RETURN DISTINCT"));
    expect(outputClause).not.toContain("callerName");
    expect(outputClause).not.toContain("callerFunction");
    expect(outputClause).not.toContain("caller.signature AS signature");
    expect(outputClause).not.toContain("callType");
    expect(outputClause).not.toContain("graphqlResolver");
    expect(params).toEqual({
      functionName: "GetUser",
      filePath: null,
    });
  });

  it("batchUpsertGraphQLDocuments merges GraphQLDocument nodes and links files when present", () => {
    const { cypher, params } = batchUpsertGraphQLDocuments([
      {
        name: "GetUser",
        kind: "query",
        filePath: "/project/src/User.tsx",
        startLine: 3,
        endLine: 9,
        signature: "query GetUser",
        snippet: "query GetUser { user { id } }",
        variableName: "GET_USER",
        resolverFieldNames: ["user"],
      },
    ]);

    expect(cypher).toContain("GraphQLDocument");
    expect(cypher).toContain("CONTAINS");
    expect(cypher).toContain("variableName");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertGraphQLResolverLinks links operation documents to resolver functions by field name", () => {
    const { cypher, params } = batchUpsertGraphQLResolverLinks([
      {
        name: "GetUser",
        kind: "query",
        filePath: "/project/src/User.tsx",
        startLine: 3,
        endLine: 9,
        signature: "query GetUser",
        snippet: "query GetUser { user { id } }",
        variableName: "GET_USER",
        resolverFieldNames: ["user"],
      },
    ]);

    expect(cypher).toContain("USES_GRAPHQL_RESOLVER");
    expect(cypher).toContain("resolverFieldNames");
    expect(cypher).toContain(":Function");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertGraphQLUsages links frontend functions to GraphQL documents", () => {
    const { cypher, params } = batchUpsertGraphQLUsages([
      {
        sourceName: "UserCard",
        sourceFilePath: "/project/src/User.tsx",
        documentName: "GetUser",
        documentFilePath: "/project/src/User.tsx",
      },
    ]);

    expect(cypher).toContain("USES_GRAPHQL");
    expect(cypher).toContain("GraphQLDocument");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertGraphQLFragmentSpreads links documents to spread fragments", () => {
    const { cypher, params } = batchUpsertGraphQLFragmentSpreads([
      {
        sourceDocumentName: "GetUser",
        sourceDocumentFilePath: "/project/src/User.tsx",
        targetFragmentName: "UserFields",
        targetFragmentFilePath: "/project/src/User.tsx",
      },
    ]);

    expect(cypher).toContain("USES_FRAGMENT");
    expect(cypher).toContain("GraphQLDocument");
    expect(params.items).toHaveLength(1);
  });

  it("clearGraphQLResolverLinks deletes stale resolver edges for a relink scope", () => {
    const { cypher, params } = clearGraphQLResolverLinks(["/project/src/User.tsx"]);

    expect(cypher).toContain("USES_GRAPHQL_RESOLVER");
    expect(cypher).toContain("DELETE r");
    expect(cypher).toContain("doc.filePath IN $filePaths");
    expect(params.filePaths).toEqual(["/project/src/User.tsx"]);
  });

  it("resolveGraphQLResolverLinks recreates resolver edges from stored field names", () => {
    const { cypher, params } = resolveGraphQLResolverLinks([]);

    expect(cypher).toContain("GraphQLDocument");
    expect(cypher).toContain("resolverFieldNames");
    expect(cypher).toContain("MATCH (resolver:Function {name: fieldName})");
    expect(cypher).toContain("USES_GRAPHQL_RESOLVER");
    expect(params.filePaths).toEqual([]);
  });
});

describe("deleteRepositoryAndFiles", () => {
  it("scopes to the given repo via CONTAINS_FILE and protoFile prefix", () => {
    const q = deleteRepositoryAndFiles({ repoPath: "/abs/root/svc-a" });
    expect(q.cypher).toContain("CONTAINS_FILE");
    expect(q.cypher).toContain("(pm:ProtoMethod)");
    expect(q.cypher).toContain("$repoPathWithSep");
    expect(q.cypher).toContain("DETACH DELETE");
    expect(q.params).toEqual({
      repoPath: "/abs/root/svc-a",
      repoPathWithSep: "/abs/root/svc-a/",
    });
  });

  it("does not double-append separator when repoPath already ends in /", () => {
    const q = deleteRepositoryAndFiles({ repoPath: "/abs/root/svc-a/" });
    expect(q.params).toEqual({
      repoPath: "/abs/root/svc-a/",
      repoPathWithSep: "/abs/root/svc-a/",
    });
  });
});
