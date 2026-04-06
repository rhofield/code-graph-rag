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

export async function writeGraphEntities(
  db: DbConnection,
  entities: GraphEntities,
  meta: FileMetadata
): Promise<void> {
  const session = db.session();
  try {
    // Upsert repository
    const repoQ = upsertRepository({
      path: meta.repoPath,
      name: meta.repoPath.split("/").pop() || meta.repoPath,
    });
    await session.run(repoQ.cypher, repoQ.params);

    // Upsert file
    const fileQ = upsertFile(meta);
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

    // Re-link file to repo (in case delete removed it)
    await session.run(fileQ.cypher, fileQ.params);

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
