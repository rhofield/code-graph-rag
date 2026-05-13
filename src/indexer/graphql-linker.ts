import type { DbConnection } from "../db/connection.js";
import {
  clearGraphQLResolverLinks,
  resolveGraphQLResolverLinks,
} from "../db/queries.js";

export async function linkGraphQLResolverEdges(
  db: DbConnection,
  filePaths: string[] = []
): Promise<number> {
  const session = db.session();
  try {
    const clearQ = clearGraphQLResolverLinks(filePaths);
    await session.run(clearQ.cypher, clearQ.params);

    const resolveQ = resolveGraphQLResolverLinks(filePaths);
    const result = await session.run(resolveQ.cypher, resolveQ.params);
    const raw = result.records[0]?.get("relationshipsCreated");
    return typeof raw?.toNumber === "function" ? raw.toNumber() : (raw ?? 0);
  } finally {
    await session.close();
  }
}
