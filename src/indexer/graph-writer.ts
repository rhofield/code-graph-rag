import type { DbConnection } from "../db/connection.js";
import type { GraphEntities } from "./extractor.js";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
} from "../db/queries.js";

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
  meta: FileMetadata
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

    // Upsert call relationships
    for (const call of entities.calls) {
      const q = upsertCallRelationship(call);
      await session.run(q.cypher, q.params);
    }
  } finally {
    await session.close();
  }
}
