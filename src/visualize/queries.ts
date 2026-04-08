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
