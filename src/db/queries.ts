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
