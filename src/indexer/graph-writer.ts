import type { DbConnection } from "../db/connection.js";
import type { GraphEntities } from "./extractor.js";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
  upsertImportRelationship,
  batchUpsertGraphQLDocuments,
  batchUpsertGraphQLResolverLinks,
  batchUpsertGraphQLUsages,
  batchUpsertGraphQLFragmentSpreads,
} from "../db/queries.js";
import { resolveImport } from "./import-resolver.js";

export interface FileMetadata {
  filePath: string;
  relativePath: string;
  repoPath: string;
  language: string;
  hash: string;
  lastModified: number;
}

export async function writeRepoOnce(db: DbConnection, repoPath: string): Promise<void> {
  const session = db.session();
  try {
    const repoQ = upsertRepository({ path: repoPath, name: repoPath.split("/").pop() || repoPath });
    await session.run(repoQ.cypher, repoQ.params);
  } finally {
    await session.close();
  }
}

export async function writeGraphEntities(
  db: DbConnection,
  entities: GraphEntities,
  meta: FileMetadata,
  filePathSet: Set<string> = new Set()
): Promise<void> {
  const session = db.session();
  try {
    // Upsert file
    const fileQ = upsertFile({
      path: meta.filePath,
      relativePath: meta.relativePath,
      repoPath: meta.repoPath,
      language: meta.language,
      hash: meta.hash,
      lastModified: meta.lastModified,
    });
    await session.run(fileQ.cypher, fileQ.params);

    // Delete old children for this file (clean re-index)
    await session.run(
      `
      MATCH (f:File {path: $filePath})-[:CONTAINS]->(child)
      OPTIONAL MATCH (child)-[:HAS_METHOD]->(method)
      DETACH DELETE method, child
      `,
      { filePath: meta.filePath }
    );

    // Upsert classes
    for (const cls of entities.classes) {
      const q = upsertClass({
        name: cls.name,
        filePath: meta.filePath,
        startLine: cls.startLine,
        endLine: cls.endLine,
        docstring: cls.docstring,
      });
      await session.run(q.cypher, q.params);
    }

    // Upsert functions
    for (const fn of entities.functions) {
      const q = upsertFunction({
        name: fn.name,
        filePath: meta.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        signature: fn.signature,
        docstring: fn.docstring,
        snippet: fn.snippet,
        className: fn.className ?? undefined,
      });
      await session.run(q.cypher, q.params);
    }

    if ((entities.graphqlDocuments ?? []).length > 0) {
      const q = batchUpsertGraphQLDocuments(entities.graphqlDocuments);
      await session.run(q.cypher, q.params);
      const resolverQ = batchUpsertGraphQLResolverLinks(entities.graphqlDocuments);
      await session.run(resolverQ.cypher, resolverQ.params);
    }

    // Upsert call relationships
    for (const call of entities.calls) {
      const q = upsertCallRelationship(call);
      await session.run(q.cypher, q.params);
    }

    if ((entities.graphqlUsages ?? []).length > 0) {
      const q = batchUpsertGraphQLUsages(entities.graphqlUsages);
      await session.run(q.cypher, q.params);
    }

    if ((entities.graphqlFragmentSpreads ?? []).length > 0) {
      const q = batchUpsertGraphQLFragmentSpreads(entities.graphqlFragmentSpreads);
      await session.run(q.cypher, q.params);
    }

    // Upsert import relationships
    for (const imp of entities.imports) {
      const target = resolveImport(imp.source, meta.filePath, meta.language, filePathSet);
      if (target) {
        const q = upsertImportRelationship({ sourceFilePath: meta.filePath, targetFilePath: target });
        await session.run(q.cypher, q.params);
      }
    }
  } finally {
    await session.close();
  }
}
