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
      LIMIT $limit
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
      LIMIT $limit
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
      LIMIT $limit
    `,
    params: { name, limit: INITIAL_LIMIT },
  };
}
