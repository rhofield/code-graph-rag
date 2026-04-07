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
