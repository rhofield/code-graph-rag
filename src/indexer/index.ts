import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { glob } from "glob";
import { minimatch } from "minimatch";
import type { DbConnection } from "../db/connection.js";
import type { IndexConfig } from "../config.js";
import { initParser, parseFile, detectLanguage } from "./parser.js";
import { extractGraphEntities } from "./extractor.js";
import { writeGraphEntities, writeRepoOnce } from "./graph-writer.js";
import { BatchGraphWriter } from "./batch-writer.js";
import {
  getRepositoryCommit,
  upsertRepositoryWithCommit,
  deleteFileAndRelationships,
  getAllFilePathsUnderPrefix,
  batchDeleteOrphanFiles,
} from "../db/queries.js";
import { computeFileHash, getFileMtime, isFileStale, getChangedFilesSinceCommit, getCurrentCommitSha } from "./staleness.js";
import { runParallelPipeline } from "./parallel-pipeline.js";

/**
 * Attempt to list files via git, which natively respects .gitignore.
 * Returns null if not a git repo or git is unavailable.
 */
function getGitFiles(absRoot: string): string[] | null {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: absRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output.split("\0").filter(Boolean).map((f) => resolve(absRoot, f));
  } catch {
    return null;
  }
}

export async function discoverFiles(
  rootPath: string,
  config: IndexConfig
): Promise<string[]> {
  const absRoot = resolve(rootPath);
  const excludePatterns = config.exclude.map((e) =>
    e.includes("/") ? e : `**/${e}/**`
  );

  // Prefer git ls-files: it natively respects .gitignore, so node_modules
  // and virtual environments are excluded without needing explicit config.
  const gitFiles = getGitFiles(absRoot);
  if (gitFiles !== null) {
    return gitFiles.filter((absPath) => {
      const rel = relative(absRoot, absPath);
      const matchesInclude = config.include.some((p) => minimatch(rel, p, { dot: true }));
      const matchesExclude = excludePatterns.some((p) => minimatch(rel, p, { dot: true }));
      return matchesInclude && !matchesExclude;
    });
  }

  // Fallback for non-git directories: use glob with manual exclude patterns.
  const allFiles: string[] = [];
  for (const pattern of config.include) {
    const matches = await glob(pattern, {
      cwd: absRoot,
      absolute: true,
      ignore: excludePatterns,
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
  orphansRemoved: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Remove File nodes (and their child Function/Class nodes) that exist in the
 * graph under `pathPrefix` but are no longer in the discovered file set.
 *
 * This is the "self-healing" pass: if a previous index run wrote files that
 * shouldn't have been indexed (e.g., venv contents written before .gitignore
 * was respected, or a file that was deleted on disk), this removes them on
 * the next full re-index.
 *
 * Safety: if discovery returned zero files but the graph has files indexed
 * under this prefix, we refuse to delete. That guards against a botched
 * discovery (wrong path, broken git, transient I/O failure) silently
 * nuking the entire repo's graph.
 */
const ORPHAN_DELETE_CHUNK_SIZE = 500;

async function cleanOrphanedFiles(
  db: DbConnection,
  pathPrefix: string,
  discoveredFiles: Set<string>
): Promise<number> {
  const session = db.session();
  try {
    const listQ = getAllFilePathsUnderPrefix({ pathPrefix });
    const result = await session.run(listQ.cypher, listQ.params);
    const indexedPaths = result.records.map((r) => r.get("path") as string);

    const orphans = indexedPaths.filter((p) => !discoveredFiles.has(p));
    if (orphans.length === 0) return 0;

    if (discoveredFiles.size === 0) {
      console.warn(
        `[indexer] orphan cleanup skipped: discovery returned 0 files but ${indexedPaths.length} are indexed under ${pathPrefix}. ` +
          `Refusing to delete to avoid wiping the graph on a botched discovery. ` +
          `If this is intentional, remove the repo manually.`
      );
      return 0;
    }

    // Chunk the deletes: a single UNWIND of thousands of DETACH DELETEs can
    // exceed Neo4j's per-transaction memory budget (MemoryPoolOutOfMemoryError).
    // 500 per chunk keeps each tx small while still cutting round-trips ~500x
    // vs. one-by-one. The trade-off: a partial run leaves some orphans, which
    // the next index will pick up — acceptable for an idempotent cleanup.
    let deleted = 0;
    for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_CHUNK_SIZE) {
      const chunk = orphans.slice(i, i + ORPHAN_DELETE_CHUNK_SIZE);
      const deleteQ = batchDeleteOrphanFiles(chunk);
      await session.run(deleteQ.cypher, deleteQ.params);
      deleted += chunk.length;
    }
    return deleted;
  } finally {
    await session.close();
  }
}

export async function indexRepository(
  db: DbConnection,
  repoPath: string,
  config: IndexConfig,
  options: {
    changedOnly?: boolean;
    specificPath?: string;
    concurrency?: number;
    maxMemoryMB?: number;
    onProgress?: (current: number, total: number, file: string) => void;
    onFlushProgress?: (completed: number, total: number) => void;
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
    orphansRemoved: 0,
    errors: [],
  };

  // Snapshot of what discovery returned, for orphan cleanup later. We capture
  // this before any post-discovery filtering so the cleanup compares against
  // the full set of files we *intend* to manage on this run.
  const discoveredSet = options.changedOnly ? null : new Set(files);

  await writeRepoOnce(db, absRoot);

  const concurrency = options.concurrency ?? 8;
  const maxMemoryBytes = (options.maxMemoryMB ?? 8192) * 1024 * 1024;

  if (concurrency > 1) {
    const batchWriter = new BatchGraphWriter(db, {});
    const pipelineResult = await runParallelPipeline({
      files,
      absRoot,
      concurrency,
      maxMemoryBytes,
      parseFn: parseFile,
      extractFn: extractGraphEntities,
      batchWriter,
      computeHashFn: computeFileHash,
      getMtimeFn: getFileMtime,
      onProgress: options.onProgress,
      onFlushProgress: options.onFlushProgress,
    });
    result.filesIndexed = pipelineResult.filesIndexed;
    result.functionsFound = pipelineResult.functionsFound;
    result.classesFound = pipelineResult.classesFound;
    result.errors = pipelineResult.errors;
  } else {
    // Sequential fallback
    const batchWriter = new BatchGraphWriter(db, {});
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      options.onProgress?.(i + 1, files.length, file);
      try {
        const parseResult = await parseFile(file);
        if (!parseResult) continue;
        let entities: ReturnType<typeof extractGraphEntities>;
        try {
          entities = extractGraphEntities(parseResult.tree, parseResult.language, parseResult.source, file);
        } finally {
          parseResult.tree.delete();
        }
        batchWriter.add(entities, {
          filePath: file, relativePath: relative(absRoot, file), repoPath: absRoot,
          language: parseResult.language,
          hash: computeFileHash(file, parseResult.source),
          lastModified: getFileMtime(file),
        });
        result.filesIndexed++;
        result.functionsFound += entities.functions.length;
        result.classesFound += entities.classes.length;
      } catch (error) {
        result.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await batchWriter.waitForPendingFlush();
    await batchWriter.flush();
  }

  // Orphan cleanup: remove File nodes that exist in the graph under our scope
  // but weren't in this run's discovered set. Skipped for changedOnly because
  // the git-diff path above already handles deletions for the incremental case.
  if (discoveredSet !== null) {
    const cleanupRoot = options.specificPath
      ? resolve(absRoot, options.specificPath)
      : absRoot;
    result.orphansRemoved = await cleanOrphanedFiles(db, cleanupRoot, discoveredSet);
  }

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
