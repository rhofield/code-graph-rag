import { resolve, relative } from "node:path";
import { glob } from "glob";
import type { DbConnection } from "../db/connection.js";
import type { IndexConfig } from "../config.js";
import { initParser, parseFile, detectLanguage } from "./parser.js";
import { extractGraphEntities } from "./extractor.js";
import { writeGraphEntities, writeRepoOnce } from "./graph-writer.js";
import { computeFileHash, getFileMtime, isFileStale } from "./staleness.js";

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
    const session = db.session();
    try {
      const result = await session.run(
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
        if (!existing) return true; // New file
        return isFileStale(f, existing.hash, existing.lastModified);
      });
    } finally {
      await session.close();
    }
  }

  const result: IndexResult = {
    filesIndexed: 0,
    functionsFound: 0,
    classesFound: 0,
    errors: [],
  };

  await writeRepoOnce(db, absRoot);

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

      await writeGraphEntities(db, entities, {
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

  return result;
}
