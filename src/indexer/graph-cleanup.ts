import type { DbConnection } from "../db/connection.js";
import { deleteRepositoryAndFiles } from "../db/queries.js";

export async function removeRepoFromGraph(db: DbConnection, absPath: string): Promise<void> {
  const session = db.session();
  try {
    const q = deleteRepositoryAndFiles({ repoPath: absPath });
    await session.run(q.cypher, q.params);
  } finally {
    await session.close();
  }
}
