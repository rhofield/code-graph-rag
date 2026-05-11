// src/visualize/queries.ts

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

export const INITIAL_LIMIT = 500;
export const EXPAND_FILE_LIMIT = 100;
export const EXPAND_FUNCTION_LIMIT = 50;
export const SEARCH_LIMIT = 25;

export function repoOverview(repoName?: string): CypherQuery {
  return {
    cypher: `
      MATCH (r:Repository)
      WHERE $repoName IS NULL OR r.name = $repoName
      MATCH (r)-[contains:CONTAINS_FILE]->(f:File)
      OPTIONAL MATCH (f)-[imp:IMPORTS]->(other:File)
      WHERE (r)-[:CONTAINS_FILE]->(other)
      RETURN r, contains, f, imp, other
      LIMIT toInteger($limit)
    `,
    params: { repoName: repoName ?? null, limit: INITIAL_LIMIT },
  };
}

export function filterByFile(relativePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {relativePath: $relativePath})
      OPTIONAL MATCH (f)-[contains:CONTAINS]->(sym)
      WHERE sym:Function OR sym:Class
      OPTIONAL MATCH (sym)-[hasMethod:HAS_METHOD]->(method:Function)
      RETURN f, contains, sym, hasMethod, method
      LIMIT toInteger($limit)
    `,
    params: { relativePath, limit: INITIAL_LIMIT },
  };
}

export function filterByFunction(name: string): CypherQuery {
  return {
    cypher: `
      MATCH (fn:Function {name: $name})
      OPTIONAL MATCH (file:File)-[contains:CONTAINS]->(fn)
      OPTIONAL MATCH (fn)-[outCall:CALLS]->(callee:Function)
      OPTIONAL MATCH (caller:Function)-[inCall:CALLS]->(fn)
      RETURN fn, file, contains, outCall, callee, inCall, caller
      LIMIT toInteger($limit)
    `,
    params: { name, limit: INITIAL_LIMIT },
  };
}

export function expandFile(filePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (f:File {path: $filePath})
      MATCH (f)-[contains:CONTAINS]->(sym)
      WHERE sym:Function OR sym:Class
      OPTIONAL MATCH (sym)-[hasMethod:HAS_METHOD]->(method:Function)
      RETURN f, contains, sym, hasMethod, method
      LIMIT toInteger($limit)
    `,
    params: { filePath, limit: EXPAND_FILE_LIMIT },
  };
}

export function expandFunction(name: string, filePath: string): CypherQuery {
  return {
    cypher: `
      MATCH (fn:Function {name: $name, filePath: $filePath})
      OPTIONAL MATCH (fn)-[outCall:CALLS]->(callee:Function)
      OPTIONAL MATCH (caller:Function)-[inCall:CALLS]->(fn)
      OPTIONAL MATCH (fn)-[protoUse:USES_PROTO]->(proto:ProtoMethod)
      OPTIONAL MATCH (peer:Function)-[peerProtoUse:USES_PROTO]->(proto)
      WHERE peer IS NULL OR peer <> fn
      RETURN fn, outCall, callee, inCall, caller, protoUse, proto, peerProtoUse, peer
      LIMIT toInteger($limit)
    `,
    params: { name, filePath, limit: EXPAND_FUNCTION_LIMIT },
  };
}

export function searchByName(prefix: string): CypherQuery {
  return {
    cypher: `
      CALL db.index.fulltext.queryNodes('code_search', $q) YIELD node, score
      WITH node, score
      WHERE node:Function OR node:Class
      RETURN node
      ORDER BY score DESC
      LIMIT toInteger($limit)
    `,
    params: { q: `${prefix}*`, limit: SEARCH_LIMIT },
  };
}
