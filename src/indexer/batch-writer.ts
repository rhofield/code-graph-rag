import type { DbConnection } from "../db/connection.js";
import type { GraphEntities, ExtractedFunction, ExtractedClass, ExtractedCall } from "./extractor.js";
import type { FileMetadata } from "./graph-writer.js";
import {
  batchDeleteFileChildren,
  batchUpsertFiles,
  batchUpsertClasses,
  batchUpsertFunctions,
  batchUpsertMethods,
  batchUpsertCallRelationships,
} from "../db/queries.js";

export class BatchGraphWriter {
  private fileMetas: FileMetadata[] = [];
  private allFunctions: ExtractedFunction[] = [];
  private allClasses: ExtractedClass[] = [];
  private allCalls: ExtractedCall[] = [];
  private _estimatedMemoryBytes = 0;
  private _pendingFlush: Promise<void> | null = null;
  private readonly batchSize: number;

  constructor(private readonly db: DbConnection, options: { batchSize?: number } = {}) {
    this.batchSize = options.batchSize ?? 50;
  }

  add(entities: GraphEntities, meta: FileMetadata): void {
    this.fileMetas.push(meta);

    const validFunctions = entities.functions.filter((fn) => fn.name !== "");
    const validClasses = entities.classes.filter((cls) => cls.name !== "");

    this.allFunctions.push(...validFunctions);
    this.allClasses.push(...validClasses);
    this.allCalls.push(...entities.calls);

    // Memory estimate: sum of snippet lengths as proxy
    for (const fn of validFunctions) {
      this._estimatedMemoryBytes += fn.snippet.length;
    }

    if (this.fileMetas.length >= this.batchSize) {
      this._pendingFlush = this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.fileMetas.length === 0) return;

    const fileMetas = this.fileMetas;
    const allFunctions = this.allFunctions;
    const allClasses = this.allClasses;
    const allCalls = this.allCalls;

    // Reset state before async work so new adds during flush go into fresh state
    this.fileMetas = [];
    this.allFunctions = [];
    this.allClasses = [];
    this.allCalls = [];
    this._estimatedMemoryBytes = 0;
    this._pendingFlush = null;

    const session = this.db.session();
    try {
      // 1. Delete old children for all files
      const filePaths = fileMetas.map((m) => m.filePath);
      const deleteQ = batchDeleteFileChildren(filePaths);
      await session.run(deleteQ.cypher, deleteQ.params);

      // 2. Upsert files
      const fileItems = fileMetas.map((m) => ({
        path: m.filePath,
        relativePath: m.relativePath,
        repoPath: m.repoPath,
        language: m.language,
        hash: m.hash,
        lastModified: m.lastModified,
      }));
      const filesQ = batchUpsertFiles(fileItems);
      await session.run(filesQ.cypher, filesQ.params);

      // 3. Upsert classes
      if (allClasses.length > 0) {
        const classItems = allClasses.map((c) => ({
          name: c.name,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          docstring: c.docstring,
        }));
        const classesQ = batchUpsertClasses(classItems);
        await session.run(classesQ.cypher, classesQ.params);
      }

      // 4. Upsert top-level functions (className === null)
      const topLevelFns = allFunctions.filter((fn) => fn.className === null);
      if (topLevelFns.length > 0) {
        const fnItems = topLevelFns.map((fn) => ({
          name: fn.name,
          filePath: fn.filePath,
          startLine: fn.startLine,
          endLine: fn.endLine,
          signature: fn.signature,
          docstring: fn.docstring,
          snippet: fn.snippet,
          className: null as string | null,
        }));
        const fnsQ = batchUpsertFunctions(fnItems);
        await session.run(fnsQ.cypher, fnsQ.params);
      }

      // 5. Upsert methods (className !== null)
      const methods = allFunctions.filter((fn) => fn.className !== null);
      if (methods.length > 0) {
        const methodItems = methods.map((fn) => ({
          name: fn.name,
          filePath: fn.filePath,
          startLine: fn.startLine,
          endLine: fn.endLine,
          signature: fn.signature,
          docstring: fn.docstring,
          snippet: fn.snippet,
          className: fn.className as string,
        }));
        const methodsQ = batchUpsertMethods(methodItems);
        await session.run(methodsQ.cypher, methodsQ.params);
      }

      // 6. Upsert call relationships
      if (allCalls.length > 0) {
        const callsQ = batchUpsertCallRelationships(allCalls);
        await session.run(callsQ.cypher, callsQ.params);
      }
    } finally {
      await session.close();
    }
  }

  async waitForPendingFlush(): Promise<void> {
    if (this._pendingFlush) {
      await this._pendingFlush;
    }
  }

  get pendingFileCount(): number {
    return this.fileMetas.length;
  }

  get estimatedMemoryBytes(): number {
    return this._estimatedMemoryBytes;
  }
}
