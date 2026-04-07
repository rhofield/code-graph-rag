import { resolve, relative } from "node:path";
import { glob } from "glob";
import type { DbConnection } from "../db/connection.js";
import type { IndexConfig } from "../config.js";
import { initParser, parseFile, detectLanguage } from "./parser.js";
import { extractGraphEntities } from "./extractor.js";
import { writeGraphEntities, writeRepoOnce } from "./graph-writer.js";
import { BatchGraphWriter } from "./batch-writer.js";
import { getRepositoryCommit, upsertRepositoryWithCommit, deleteFileAndRelationships } from "../db/queries.js";
import { computeFileHash, getFileMtime, isFileStale, getChangedFilesSinceCommit, getCurrentCommitSha } from "./staleness.js";

export async function discoverFiles(
  rootPath: string,
  config: IndexConfig
): Promise<string[]> {
  const absRoot = resolve(rootPath);
  const allFiles: string[] = [];

  for (const pattern of config.include) {
    const matches = await glob(pattern, {
      cwd: absRoot,
      absolute: true,
      ignore: config.exclude.map((e) =>
        e.includes("/") ? e : `**/${e}/**`
      ),
      nodir: true,
    });
    allFiles.push(...matches);
  }

  return [...new Set(allFiles)];
}

export interface IndexResult {
  filesIndexed: number;
  functionsFound: number;
  classesFound: number;
  errors: Array<{ file: string; error: string }>;
}

export async function indexRepository(
  db: DbConnection,
  repoPath: string,
  config: IndexConfig,
  options: {
    changedOnly?: boolean;
    specificPath?: string;
    onProgress?: (current: number, total: number, file: string) => void;
  } = {}
): Promise<IndexResult> {
  const absRoot = resolve(repoPath);
  await initParser();

  let files: string[];
  if (options.specificPath) {
    files = await discoverFiles(resolve(absRoot, options.specificPath), config);
  } else {
    files = await discoverFiles(absRoot, config);
  }

  // Filter to supported languages
  files = files.filter((f) => detectLanguage(f) !== null);

  // If changedOnly, check staleness against existing graph
  if (options.changedOnly) {
    // Try git-based incremental first
    const session = db.session();
    let usedGitBased = false;
    try {
      const commitQ = getRepositoryCommit({ path: absRoot });
      const result = await session.run(commitQ.cypher, commitQ.params);
      const lastCommit: string | null = result.records[0]?.get("lastIndexedCommit") ?? null;

      if (lastCommit) {
        const diff = getChangedFilesSinceCommit(absRoot, lastCommit, { includeDeleted: true });

        if (diff.error) {
          // Git failed (invalid SHA, shallow clone, etc.) — fall through to hash/mtime
        } else {
          // Remove deleted files from the index
          for (const relPath of diff.deleted) {
            const absPath = resolve(absRoot, relPath);
            const deleteQ = deleteFileAndRelationships({ filePath: absPath });
            await session.run(deleteQ.cypher, deleteQ.params);  // let errors propagate
          }

          // Filter files to only changed ones
          const changedAbsPaths = new Set(diff.changed.map((f) => resolve(absRoot, f)));
          files = files.filter((f) => changedAbsPaths.has(f));
          usedGitBased = true;
        }
      }
    } finally {
      await session.close();
    }

    // Fall back to mtime/hash-based staleness if git-based wasn't used
    if (!usedGitBased) {
      const session2 = db.session();
      try {
        const result = await session2.run(
          "MATCH (f:File) WHERE f.path STARTS WITH $repoPath RETURN f.path AS path, f.hash AS hash, f.lastModified AS lastModified",
          { repoPath: absRoot }
        );
        const indexed = new Map(
          result.records.map((r) => [
            r.get("path"),
            { hash: r.get("hash"), lastModified: r.get("lastModified") },
          ])
        );
        files = files.filter((f) => {
          const existing = indexed.get(f);
          if (!existing) return true;
          return isFileStale(f, existing.hash, existing.lastModified);
        });
      } finally {
        await session2.close();
      }
    }
  }

  const result: IndexResult = {
    filesIndexed: 0,
    functionsFound: 0,
    classesFound: 0,
    errors: [],
  };

  await writeRepoOnce(db, absRoot);

  const batchWriter = new BatchGraphWriter(db, { batchSize: 50 });

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    options.onProgress?.(i + 1, files.length, file);

    try {
      const parseResult = await parseFile(file);
      if (!parseResult) continue;

      const entities = extractGraphEntities(
        parseResult.tree,
        parseResult.language,
        parseResult.source,
        file
      );

      batchWriter.add(entities, {
        filePath: file,
        relativePath: relative(absRoot, file),
        repoPath: absRoot,
        language: parseResult.language,
        hash: computeFileHash(file, parseResult.source),
        lastModified: getFileMtime(file),
      });

      result.filesIndexed++;
      result.functionsFound += entities.functions.length;
      result.classesFound += entities.classes.length;
    } catch (error) {
      result.errors.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await batchWriter.waitForPendingFlush();
  await batchWriter.flush();

  if (result.errors.length === 0) {
    const commitSha = getCurrentCommitSha(absRoot);
    if (commitSha) {
      const session = db.session();
      try {
        const q = upsertRepositoryWithCommit({
          path: absRoot,
          name: absRoot.split("/").pop() || absRoot,
          lastIndexedCommit: commitSha,
        });
        await session.run(q.cypher, q.params);
      } finally {
        await session.close();
      }
    }
  }

  return result;
}
