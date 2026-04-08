// src/visualize/queries.ts

export interface CypherQuery {
  cypher: string;
  params: Record<string, unknown>;
}

export const INITIAL_LIMIT = 500;
export const EXPAND_FILE_LIMIT = 100;
export const EXPAND_FUNCTION_LIMIT = 50;
export const SEARCH_LIMIT = 25;
