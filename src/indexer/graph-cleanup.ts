import type { DbConnection } from "../db/connection.js";
import { deleteRepositoryAndFiles } from "../db/queries.js";
import type { ResolveReposResult } from "./resolve-repos.js";

export async function removeRepoFromGraph(db: DbConnection, absPath: string): Promise<void> {
  const session = db.session();
  try {
    const q = deleteRepositoryAndFiles({ repoPath: absPath });
    await session.run(q.cypher, q.params);
  } finally {
    await session.close();
  }
}

export function printResolveResult(resolved: ResolveReposResult): void {
  if (resolved.warning) console.warn(resolved.warning);
  if (resolved.added.length > 0) console.log(`Discovered new repos: ${resolved.added.join(", ")}`);
  if (resolved.removed.length > 0) console.log(`Removed missing repos: ${resolved.removed.join(", ")}`);
}
