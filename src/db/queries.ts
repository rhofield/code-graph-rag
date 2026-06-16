// src/db/queries.ts

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

export function upsertRepository(data: {
  path: string;
  name: string;
}): CypherQuery {
  return {
    cypher: `
      MERGE (r:Repository {path: $path})
      SET r.name = $name, r.lastIndexedAt = datetime()
    `,
    params: data,
  };
}

export function upsertFile(data: {
  path: string;
  relativePath: string;
  repoPath: string;
  language: string;
  hash: string;
  lastModified: number;
}): CypherQuery {
  return {
    cypher: `
      MATCH (r:Repository {path: $repoPath})
      MERGE (f:File {path: $path})
      SET f.relativePath = $relativePath,
          f.language = $language,
          f.hash = $hash,
          f.lastModified = $lastModified
      MERGE (r)-[:CONTAINS_FILE]->(f)
    `,
    params: data,
  };
}

export function upsertFunction(data: {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  docstring: string | null;
  snippet: string;
  className?: string;
}): CypherQuery {
  if (data.className) {
    return {
      cypher: `
        MATCH (c:Class {name: $className})<-[:CONTAINS]-(:File {path: $filePath})
        MERGE (fn:Function {name: $name, filePath: $filePath, className: $className})
        SET fn.startLine = $startLine,
            fn.endLine = $endLine,
            fn.signature = $signature,
            fn.docstring = $docstring,
            fn.snippet = $snippet
        MERGE (c)-[:HAS_METHOD]->(fn)
      `,
      params: data,
    };
  }
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MERGE (fn:Function {name: $name, filePath: $filePath})
      ON CREATE SET fn.className = null
      SET fn.startLine = $startLine,
          fn.endLine = $endLine,
          fn.signature = $signature,
          fn.docstring = $docstring,
          fn.snippet = $snippet
      MERGE (f)-[:CONTAINS]->(fn)
    `,
    params: { ...data, className: null },
  };
}

export function upsertClass(data: {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  docstring: string | null;
}): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MERGE (c:Class {name: $name, filePath: $filePath})
      SET c.startLine = $startLine,
          c.endLine = $endLine,
          c.docstring = $docstring
      MERGE (f)-[:CONTAINS]->(c)
    `,
    params: data,
  };
}

export function upsertCallRelationship(data: {
  callerName: string;
  callerFilePath: string;
  calleeName: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (caller:Function {name: $callerName, filePath: $callerFilePath})
      MATCH (callee:Function {name: $calleeName})
      MERGE (caller)-[:CALLS]->(callee)
    `,
    params: data,
  };
}

export function upsertImportRelationship(data: {
  sourceFilePath: string;
  targetFilePath: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (source:File {path: $sourceFilePath})
      MATCH (target:File {path: $targetFilePath})
      MERGE (source)-[:IMPORTS]->(target)
    `,
    params: data,
  };
}

export function upsertImportSymbol(data: {
  sourceFilePath: string;
  symbolName: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (source:File {path: $sourceFilePath})
      MATCH (symbol) WHERE (symbol:Function OR symbol:Class) AND symbol.name = $symbolName
      MERGE (source)-[:IMPORTS_SYMBOL]->(symbol)
    `,
    params: data,
  };
}

export function functionCallersQuery(data: {
  functionName: string;
  filePath?: string | null;
  verbose?: boolean;
}): CypherQuery {
  const returnClause =
    data.verbose === false
      ? `
      RETURN DISTINCT caller.name AS caller,
             caller.filePath AS file
      ORDER BY file, caller
    `
      : `
      RETURN DISTINCT caller.name AS callerName,
             caller.name AS caller,
             caller.filePath AS callerFilePath,
             caller.filePath AS file,
             caller.signature AS signature,
             caller.startLine AS startLine,
             caller.startLine AS line,
             callType,
             rpcService,
             rpcMethod,
             protoService,
             protoMethod,
             protoRole,
             graphqlDocument,
             graphqlField,
             graphqlResolver
      ORDER BY callerFilePath, callerName, callType
    `;

  return {
    cypher: `
      MATCH (target:Function {name: $functionName})
      WHERE $filePath IS NULL OR target.filePath = $filePath
      CALL {
        WITH target
        MATCH (caller:Function)-[r:CALLS|RPC_CALLS]->(target)
        WITH caller, r,
             // Hide generated.pb.go / *_pb.ts bridge functions from normal caller results.
             coalesce(caller.filePath, "") ENDS WITH ".pb.go" OR
             coalesce(caller.filePath, "") ENDS WITH "_grpc.pb.go" OR
             coalesce(caller.filePath, "") ENDS WITH "_pb.ts" OR
             coalesce(caller.filePath, "") ENDS WITH "_pb.js" OR
             coalesce(caller.filePath, "") ENDS WITH "_grpc_pb.ts" OR
             coalesce(caller.filePath, "") ENDS WITH "_grpc_pb.js" AS isGeneratedProtoCaller
        WHERE NOT isGeneratedProtoCaller
        RETURN caller,
               type(r) AS callType,
               r.serviceName AS rpcService,
               r.methodName AS rpcMethod,
               null AS protoService,
               null AS protoMethod,
               null AS protoRole,
               null AS graphqlDocument,
               null AS graphqlField,
               null AS graphqlResolver
        UNION
        WITH target
        MATCH (target)-[targetUse:USES_PROTO]->(proto:ProtoMethod)
        RETURN {
                 name: proto.serviceName + "." + proto.methodName,
                 filePath: proto.protoFile,
                 signature: null,
                 startLine: null
               } AS caller,
               "PROTO_CANONICAL" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               proto.serviceName AS protoService,
               proto.methodName AS protoMethod,
               targetUse.role AS protoRole,
               null AS graphqlDocument,
               null AS graphqlField,
               null AS graphqlResolver
        UNION
        WITH target
        MATCH (target)-[:USES_PROTO]->(proto:ProtoMethod)<-[peerUse:USES_PROTO]-(caller:Function)
        WHERE caller <> target
          AND peerUse.role IN ["consumer", "caller"]
        RETURN caller,
               "USES_PROTO" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               proto.serviceName AS protoService,
               proto.methodName AS protoMethod,
               peerUse.role AS protoRole,
               null AS graphqlDocument,
               null AS graphqlField,
               null AS graphqlResolver
        UNION
        WITH target
        MATCH (doc:GraphQLDocument)-[gqlRel:USES_GRAPHQL_RESOLVER]->(target)
        MATCH (caller:Function)-[:USES_GRAPHQL]->(doc)
        RETURN caller,
               "USES_GRAPHQL" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               null AS protoService,
               null AS protoMethod,
               null AS protoRole,
               doc.name AS graphqlDocument,
               gqlRel.fieldName AS graphqlField,
               target.name AS graphqlResolver
        UNION
        WITH target
        MATCH (resolver:Function)-[:CALLS|RPC_CALLS]->(target)
        MATCH (doc:GraphQLDocument)-[gqlRel:USES_GRAPHQL_RESOLVER]->(resolver)
        MATCH (caller:Function)-[:USES_GRAPHQL]->(doc)
        RETURN caller,
               "USES_GRAPHQL_RESOLVER" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               null AS protoService,
               null AS protoMethod,
               null AS protoRole,
               doc.name AS graphqlDocument,
               gqlRel.fieldName AS graphqlField,
               resolver.name AS graphqlResolver
        UNION
        WITH target
        MATCH (target)-[:USES_PROTO]->(proto:ProtoMethod)<-[resolverUse:USES_PROTO]-(resolver:Function)
        WHERE resolver <> target
          AND resolverUse.role IN ["consumer", "caller"]
        MATCH (doc:GraphQLDocument)-[gqlRel:USES_GRAPHQL_RESOLVER]->(resolver)
        MATCH (caller:Function)-[:USES_GRAPHQL]->(doc)
        RETURN caller,
               "USES_GRAPHQL_PROTO" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               proto.serviceName AS protoService,
               proto.methodName AS protoMethod,
               resolverUse.role AS protoRole,
               doc.name AS graphqlDocument,
               gqlRel.fieldName AS graphqlField,
               resolver.name AS graphqlResolver
        UNION
        // generated proto dispatcher target: collapse through its canonical proto method
        WITH target
        MATCH (target)-[dispatcherUse:USES_PROTO]->(proto:ProtoMethod)<-[resolverUse:USES_PROTO]-(resolver:Function)
        WHERE resolver <> target
          AND dispatcherUse.role IN ["caller", "handler"]
          AND resolverUse.role IN ["consumer", "caller"]
        MATCH (doc:GraphQLDocument)-[gqlRel:USES_GRAPHQL_RESOLVER]->(resolver)
        MATCH (caller:Function)-[:USES_GRAPHQL]->(doc)
        RETURN caller,
               "USES_GRAPHQL_PROTO_DISPATCHER" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               proto.serviceName AS protoService,
               proto.methodName AS protoMethod,
               resolverUse.role AS protoRole,
               doc.name AS graphqlDocument,
               gqlRel.fieldName AS graphqlField,
               resolver.name AS graphqlResolver
        UNION
        // generated proto dispatcher target: collapse through the real handler it invokes
        WITH target
        MATCH (target)-[:CALLS|RPC_CALLS]->(handler:Function)
        MATCH (handler)-[:USES_PROTO]->(proto:ProtoMethod)<-[resolverUse:USES_PROTO]-(resolver:Function)
        WHERE resolver <> target
          AND resolver <> handler
          AND resolverUse.role IN ["consumer", "caller"]
        MATCH (doc:GraphQLDocument)-[gqlRel:USES_GRAPHQL_RESOLVER]->(resolver)
        MATCH (caller:Function)-[:USES_GRAPHQL]->(doc)
        RETURN caller,
               "USES_GRAPHQL_PROTO_DISPATCHER" AS callType,
               null AS rpcService,
               null AS rpcMethod,
               proto.serviceName AS protoService,
               proto.methodName AS protoMethod,
               resolverUse.role AS protoRole,
               doc.name AS graphqlDocument,
               gqlRel.fieldName AS graphqlField,
               resolver.name AS graphqlResolver
      }
      ${returnClause}
    `,
    params: {
      functionName: data.functionName,
      filePath: data.filePath ?? null,
    },
  };
}

export function batchUpsertFiles(items: Array<{
  path: string; relativePath: string; repoPath: string;
  language: string; hash: string; lastModified: number;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (r:Repository {path: item.repoPath})
      MERGE (f:File {path: item.path})
      SET f.relativePath = item.relativePath,
          f.language = item.language,
          f.hash = item.hash,
          f.lastModified = item.lastModified
      MERGE (r)-[:CONTAINS_FILE]->(f)
    `,
    params: { items },
  };
}

export function batchDeleteFileChildren(filePaths: string[]): CypherQuery {
  return {
    cypher: `
      UNWIND $filePaths AS fp
      MATCH (f:File {path: fp})-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child
    `,
    params: { filePaths },
  };
}

export function batchUpsertFunctions(items: Array<{
  name: string; filePath: string; startLine: number; endLine: number;
  signature: string; docstring: string | null; snippet: string;
  className: string | null;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (f:File {path: item.filePath})
      MERGE (fn:Function {name: item.name, filePath: item.filePath})
      ON CREATE SET fn.className = null
      SET fn.startLine = item.startLine,
          fn.endLine = item.endLine,
          fn.signature = item.signature,
          fn.docstring = item.docstring,
          fn.snippet = item.snippet
      MERGE (f)-[:CONTAINS]->(fn)
    `,
    params: { items },
  };
}

export function batchUpsertMethods(items: Array<{
  name: string; filePath: string; startLine: number; endLine: number;
  signature: string; docstring: string | null; snippet: string;
  className: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (c:Class {name: item.className})<-[:CONTAINS]-(:File {path: item.filePath})
      MERGE (fn:Function {name: item.name, filePath: item.filePath, className: item.className})
      SET fn.startLine = item.startLine,
          fn.endLine = item.endLine,
          fn.signature = item.signature,
          fn.docstring = item.docstring,
          fn.snippet = item.snippet
      MERGE (c)-[:HAS_METHOD]->(fn)
    `,
    params: { items },
  };
}

export function batchUpsertClasses(items: Array<{
  name: string; filePath: string; startLine: number; endLine: number;
  docstring: string | null;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (f:File {path: item.filePath})
      MERGE (c:Class {name: item.name, filePath: item.filePath})
      SET c.startLine = item.startLine,
          c.endLine = item.endLine,
          c.docstring = item.docstring
      MERGE (f)-[:CONTAINS]->(c)
    `,
    params: { items },
  };
}

export function batchUpsertImportRelationships(items: Array<{
  sourceFilePath: string;
  targetFilePath: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (source:File {path: item.sourceFilePath})
      MATCH (target:File {path: item.targetFilePath})
      MERGE (source)-[:IMPORTS]->(target)
    `,
    params: { items },
  };
}

export function batchUpsertCallRelationships(items: Array<{
  callerName: string; callerFilePath: string; calleeName: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (caller:Function {name: item.callerName, filePath: item.callerFilePath})
      MATCH (callee:Function {name: item.calleeName})
      MERGE (caller)-[:CALLS]->(callee)
    `,
    params: { items },
  };
}

export function batchUpsertProtoUsageRelationships(items: Array<{
  functionName: string;
  filePath: string;
  serviceName: string;
  methodName: string;
  role: "caller" | "handler" | "consumer";
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      MATCH (m:ProtoMethod {serviceName: item.serviceName, methodName: item.methodName})
      MERGE (fn)-[r:USES_PROTO {role: item.role}]->(m)
      SET r.serviceName = item.serviceName,
          r.methodName = item.methodName
    `,
    params: { items },
  };
}

export function batchUpsertGraphQLDocuments(items: Array<{
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  snippet: string;
  variableName: string | null;
  resolverFieldNames?: string[];
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MERGE (doc:GraphQLDocument {name: item.name, kind: item.kind, filePath: item.filePath})
      SET doc.startLine = item.startLine,
          doc.endLine = item.endLine,
          doc.signature = item.signature,
          doc.snippet = item.snippet,
          doc.variableName = item.variableName,
          doc.resolverFieldNames = coalesce(item.resolverFieldNames, [])
      WITH item, doc
      OPTIONAL MATCH (f:File {path: item.filePath})
      FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END |
        MERGE (f)-[:CONTAINS]->(doc)
      )
    `,
    params: { items },
  };
}

export function batchUpsertGraphQLResolverLinks(items: Array<{
  name: string;
  kind: string;
  filePath: string;
  resolverFieldNames?: string[];
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (doc:GraphQLDocument {name: item.name, kind: item.kind, filePath: item.filePath})
      WITH item, doc, coalesce(item.resolverFieldNames, []) AS resolverFieldNames
      UNWIND resolverFieldNames AS fieldName
      MATCH (resolver:Function {name: fieldName})
      MERGE (doc)-[r:USES_GRAPHQL_RESOLVER]->(resolver)
      SET r.fieldName = fieldName
    `,
    params: { items },
  };
}

export function clearGraphQLResolverLinks(filePaths: string[] = []): CypherQuery {
  return {
    cypher: `
      MATCH (doc:GraphQLDocument)-[r:USES_GRAPHQL_RESOLVER]->()
      WHERE size($filePaths) = 0 OR doc.filePath IN $filePaths
      DELETE r
    `,
    params: { filePaths },
  };
}

export function resolveGraphQLResolverLinks(filePaths: string[] = []): CypherQuery {
  // Two scopes, deduplicated by MERGE:
  // 1. doc-side — documents in the touched files link to any matching resolver
  // 2. resolver-side — functions in the touched files link back from any
  //    document whose fields reference them. Without this, re-indexing only
  //    the resolver repo (e.g. after a resolver is renamed to match a new
  //    operation field) never relinks documents whose own files were untouched.
  return {
    cypher: `
      CALL {
        MATCH (doc:GraphQLDocument)
        WHERE size($filePaths) = 0 OR doc.filePath IN $filePaths
        WITH doc, coalesce(doc.resolverFieldNames, []) AS resolverFieldNames
        UNWIND resolverFieldNames AS fieldName
        MATCH (resolver:Function {name: fieldName})
        MERGE (doc)-[r:USES_GRAPHQL_RESOLVER]->(resolver)
        SET r.fieldName = fieldName
        RETURN count(r) AS created
        UNION ALL
        MATCH (resolver:Function)
        WHERE size($filePaths) > 0 AND resolver.filePath IN $filePaths
        MATCH (doc:GraphQLDocument)
        WHERE resolver.name IN coalesce(doc.resolverFieldNames, [])
        MERGE (doc)-[r:USES_GRAPHQL_RESOLVER]->(resolver)
        SET r.fieldName = resolver.name
        RETURN count(r) AS created
      }
      RETURN sum(created) AS relationshipsCreated
    `,
    params: { filePaths },
  };
}

export function batchUpsertGraphQLUsages(items: Array<{
  sourceName: string;
  sourceFilePath: string;
  documentName: string;
  documentFilePath: string | null;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (source:Function {name: item.sourceName, filePath: item.sourceFilePath})
      MATCH (doc:GraphQLDocument {name: item.documentName})
      WHERE item.documentFilePath IS NULL OR doc.filePath = item.documentFilePath
      MERGE (source)-[:USES_GRAPHQL]->(doc)
    `,
    params: { items },
  };
}

export function batchUpsertGraphQLFragmentSpreads(items: Array<{
  sourceDocumentName: string;
  sourceDocumentFilePath: string;
  targetFragmentName: string;
  targetFragmentFilePath: string | null;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (source:GraphQLDocument {name: item.sourceDocumentName, filePath: item.sourceDocumentFilePath})
      MATCH (target:GraphQLDocument {name: item.targetFragmentName, kind: "fragment"})
      WHERE item.targetFragmentFilePath IS NULL OR target.filePath = item.targetFragmentFilePath
      MERGE (source)-[:USES_FRAGMENT]->(target)
    `,
    params: { items },
  };
}

export function upsertRepositoryWithCommit(data: {
  path: string;
  name: string;
  lastIndexedCommit: string;
}): CypherQuery {
  return {
    cypher: `
      MERGE (r:Repository {path: $path})
      SET r.name = $name,
          r.lastIndexedAt = datetime(),
          r.lastIndexedCommit = $lastIndexedCommit
    `,
    params: data,
  };
}

export function getRepositoryCommit(data: { path: string }): CypherQuery {
  return {
    cypher: `
      MATCH (r:Repository {path: $path})
      RETURN r.lastIndexedCommit AS lastIndexedCommit
    `,
    params: data,
  };
}

export function deleteFileAndRelationships(data: {
  filePath: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      OPTIONAL MATCH (f)-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child, f
    `,
    params: data,
  };
}

export function getAllFilePathsUnderPrefix(data: {
  pathPrefix: string;
}): CypherQuery {
  return {
    cypher: `
      MATCH (f:File)
      WHERE f.path STARTS WITH $pathPrefix
      RETURN f.path AS path
    `,
    params: data,
  };
}

export function batchDeleteOrphanFiles(filePaths: string[]): CypherQuery {
  return {
    cypher: `
      UNWIND $filePaths AS fp
      MATCH (f:File {path: fp})
      OPTIONAL MATCH (f)-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child, f
    `,
    params: { filePaths },
  };
}

/**
 * Delete a Repository node, every File under it (via CONTAINS_FILE), their
 * Function/Class children, and any ProtoMethod nodes keyed to .proto files
 * inside the repo. Used when a previously-known subrepo is no longer present.
 *
 * Using the CONTAINS_FILE relationship (rather than a path prefix on File)
 * avoids accidentally matching sibling repos whose paths share a prefix
 * (e.g. /root/svc-a vs /root/svc-a-old).
 *
 * ProtoMethod nodes are matched by protoFile prefix with a trailing separator
 * for the same reason.
 *
 * Inbound RPC_CALLS from surviving cross-repo callers are severed by
 * DETACH DELETE of the handler functions; re-indexing the caller repo
 * re-links them.
 */
export function deleteRepositoryAndFiles(data: { repoPath: string }): CypherQuery {
  const repoPathWithSep = data.repoPath.endsWith("/") ? data.repoPath : data.repoPath + "/";
  return {
    cypher: `
      OPTIONAL MATCH (r:Repository {path: $repoPath})
      OPTIONAL MATCH (r)-[:CONTAINS_FILE]->(f:File)
      OPTIONAL MATCH (f)-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      OPTIONAL MATCH (pm:ProtoMethod) WHERE pm.protoFile STARTS WITH $repoPathWithSep
      OPTIONAL MATCH (pmsg:ProtoMessage) WHERE pmsg.protoFile STARTS WITH $repoPathWithSep
      DETACH DELETE method, child, f, pm, pmsg, r
    `,
    params: { repoPath: data.repoPath, repoPathWithSep },
  };
}

export function batchSetRpcHandlerMeta(items: Array<{
  functionName: string;
  filePath: string;
  rpcService: string;
  rpcMethod: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      SET fn.rpcHandlerService = item.rpcService,
          fn.rpcHandlerMethod = item.rpcMethod
    `,
    params: { items },
  };
}

export function batchSetRpcCallerMeta(items: Array<{
  functionName: string;
  filePath: string;
  rpcServices: string[];
  rpcMethods: string[];
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      SET fn.rpcCallerServices = item.rpcServices,
          fn.rpcCallerMethods = item.rpcMethods
    `,
    params: { items },
  };
}

export function clearRpcMetaForFiles(filePaths: string[]): CypherQuery {
  return {
    cypher: `
      UNWIND $filePaths AS fp
      MATCH (fn:Function {filePath: fp})
      OPTIONAL MATCH (fn)-[out:RPC_CALLS]->()
      OPTIONAL MATCH ()-[inc:RPC_CALLS]->(fn)
      OPTIONAL MATCH (fn)-[protoUse:USES_PROTO]->()
      DELETE out, inc, protoUse
      REMOVE fn.rpcCallerServices, fn.rpcCallerMethods,
             fn.rpcHandlerService, fn.rpcHandlerMethod
    `,
    params: { filePaths },
  };
}

export function batchUpsertProtoDefs(items: Array<{
  serviceName: string;
  methodName: string;
  methodCamel: string;
  requestType: string;
  responseType: string;
  packageName: string;
  protoFile: string;
  goPackage?: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MERGE (m:ProtoMethod {serviceName: item.serviceName, methodName: item.methodName})
      SET m.methodCamel = item.methodCamel,
          m.requestType = item.requestType,
          m.responseType = item.responseType,
          m.packageName = item.packageName,
          m.protoFile = item.protoFile,
          m.goPackage = item.goPackage
    `,
    params: { items: items.map((i) => ({ ...i, goPackage: i.goPackage ?? null })) },
  };
}

export function loadAllProtoDefs(): CypherQuery {
  return {
    cypher: `
      MATCH (m:ProtoMethod)
      RETURN m.serviceName AS serviceName,
             m.methodName AS methodName,
             m.methodCamel AS methodCamel,
             m.requestType AS requestType,
             m.responseType AS responseType,
             m.packageName AS packageName,
             m.protoFile AS protoFile,
             m.goPackage AS goPackage
    `,
    params: {},
  };
}

export function batchDeleteOrphanProtoMethods(
  keep: Array<{ serviceName: string; methodName: string }>,
  protoFilePathPrefix: string
): CypherQuery {
  return {
    cypher: `
      WITH [k IN $keep | k.serviceName + "::" + k.methodName] AS keepKeys
      MATCH (m:ProtoMethod)
      WHERE m.protoFile STARTS WITH $protoFilePathPrefix
        AND NOT (m.serviceName + "::" + m.methodName) IN keepKeys
      DETACH DELETE m
    `,
    params: { keep, protoFilePathPrefix },
  };
}

export function batchUpsertProtoMessages(items: Array<{
  messageName: string;
  packageName: string;
  protoFile: string;
  goPackage?: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MERGE (m:ProtoMessage {messageName: item.messageName, packageName: item.packageName})
      SET m.protoFile = item.protoFile,
          m.goPackage = item.goPackage
    `,
    params: { items: items.map((i) => ({ ...i, goPackage: i.goPackage ?? null })) },
  };
}

export function loadAllProtoMessages(): CypherQuery {
  return {
    cypher: `
      MATCH (m:ProtoMessage)
      RETURN m.messageName AS messageName,
             m.packageName AS packageName,
             m.protoFile AS protoFile,
             m.goPackage AS goPackage
    `,
    params: {},
  };
}

export function batchDeleteOrphanProtoMessages(
  keep: Array<{ messageName: string; packageName: string }>,
  protoFilePathPrefix: string
): CypherQuery {
  return {
    cypher: `
      WITH [k IN $keep | k.packageName + "::" + k.messageName] AS keepKeys
      MATCH (m:ProtoMessage)
      WHERE m.protoFile STARTS WITH $protoFilePathPrefix
        AND NOT (m.packageName + "::" + m.messageName) IN keepKeys
      DETACH DELETE m
    `,
    params: { keep, protoFilePathPrefix },
  };
}

export function batchUpsertMessageUsageRelationships(items: Array<{
  functionName: string;
  filePath: string;
  role: "producer" | "consumer" | "uses";
  messageName: string;
  packageName: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      MATCH (m:ProtoMessage {messageName: item.messageName, packageName: item.packageName})
      MERGE (fn)-[r:USES_PROTO {role: item.role}]->(m)
      SET r.messageName = item.messageName,
          r.packageName = item.packageName
    `,
    params: { items },
  };
}

export function resolveRpcEdges(): CypherQuery {
  return {
    cypher: `
      MATCH (caller:Function)
      WHERE caller.rpcCallerServices IS NOT NULL
      WITH caller, range(0, size(caller.rpcCallerServices) - 1) AS indices
      UNWIND indices AS i
      WITH caller, caller.rpcCallerServices[i] AS svc, caller.rpcCallerMethods[i] AS method
      MATCH (handler:Function {rpcHandlerService: svc, rpcHandlerMethod: method})
      MERGE (caller)-[r:RPC_CALLS]->(handler)
      SET r.serviceName = svc, r.methodName = method
      RETURN count(r) AS edgesCreated
    `,
    params: {},
  };
}
