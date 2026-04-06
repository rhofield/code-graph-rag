// src/mcp/staleness-check.ts
import type { DbConnection } from "../db/connection.js";
import { isFileStale as defaultIsFileStale } from "../indexer/staleness.js";

const STALE_THRESHOLD = 20;

export interface StalenessResult {
  staleFiles: string[];
  needsWarning: boolean;
}

export async function checkStaleness(
  db: DbConnection,
  filePaths: string[],
  isStaleCheck: (
    filePath: string,
    storedHash: string,
    storedMtime: number
  ) => boolean = defaultIsFileStale
): Promise<StalenessResult> {
  if (filePaths.length === 0) {
    return { staleFiles: [], needsWarning: false };
  }

  const session = db.session();
  try {
    const result = await session.run(
      "MATCH (f:File) WHERE f.path IN $paths RETURN f.path AS path, f.hash AS hash, f.lastModified AS lastModified",
      { paths: filePaths }
    );

    const staleFiles: string[] = [];
    for (const record of result.records) {
      const path = record.get("path") as string;
      const hash = record.get("hash") as string;
      const lastModified = record.get("lastModified") as number;

      if (isStaleCheck(path, hash, lastModified)) {
        staleFiles.push(path);
      }
    }

    return {
      staleFiles,
      needsWarning: staleFiles.length > STALE_THRESHOLD,
    };
  } finally {
    await session.close();
  }
}

export function formatStalenessWarning(staleCount: number): string {
  return `Warning: Index is stale for ${staleCount} files. Run \`code-graph-rag index --changed\` for full refresh.`;
}
