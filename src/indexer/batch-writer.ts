import type { DbConnection } from "../db/connection.js";
import type { GraphEntities, ExtractedFunction, ExtractedClass, ExtractedCall } from "./extractor.js";
import type { FileMetadata } from "./graph-writer.js";
import { Semaphore } from "./parallel-pipeline.js";
import {
  batchDeleteFileChildren,
  batchUpsertFiles,
  batchUpsertClasses,
  batchUpsertFunctions,
  batchUpsertMethods,
  batchUpsertCallRelationships,
} from "../db/queries.js";

interface FlushSnapshot {
  fileMetas: FileMetadata[];
  functions: ExtractedFunction[];
  classes: ExtractedClass[];
  calls: ExtractedCall[];
}

export class BatchGraphWriter {
  private fileMetas: FileMetadata[] = [];
  private allFunctions: ExtractedFunction[] = [];
  private allClasses: ExtractedClass[] = [];
  private allCalls: ExtractedCall[] = [];
  private _estimatedMemoryBytes = 0;
  private _flushSem = new Semaphore(1);
  private _inFlight = new Set<Promise<void>>();
  private _flushError: Error | null = null;
  private readonly batchSize: number;
  private _flushesScheduled = 0;
  private _flushesCompleted = 0;
  onFlushProgress?: (completed: number, total: number) => void;

  constructor(private readonly db: DbConnection, options: { batchSize?: number } = {}) {
    this.batchSize = options.batchSize ?? 200;
  }

  add(entities: GraphEntities, meta: FileMetadata): void {
    if (this._flushError) {
      const err = this._flushError;
      this._flushError = null;
      throw err;
    }

    this.fileMetas.push(meta);

    const validFunctions = entities.functions.filter((fn) => fn.name !== "");
    const validClasses = entities.classes.filter((cls) => cls.name !== "");

    this.allFunctions.push(...validFunctions);
    this.allClasses.push(...validClasses);
    this.allCalls.push(...entities.calls);

    for (const fn of validFunctions) {
      this._estimatedMemoryBytes += fn.snippet.length;
    }

    if (this.fileMetas.length >= this.batchSize) {
      this._scheduleFlush(this._snapshot());
    }
  }

  private _snapshot(): FlushSnapshot {
    const snapshot: FlushSnapshot = {
      fileMetas: this.fileMetas,
      functions: this.allFunctions,
      classes: this.allClasses,
      calls: this.allCalls,
    };
    this.fileMetas = [];
    this.allFunctions = [];
    this.allClasses = [];
    this.allCalls = [];
    this._estimatedMemoryBytes = 0;
    return snapshot;
  }

  private _scheduleFlush(snapshot: FlushSnapshot): void {
    if (snapshot.fileMetas.length === 0) return;

    this._flushesScheduled++;
    const p = this._runFlush(snapshot)
      .then(() => {
        this._flushesCompleted++;
        this.onFlushProgress?.(this._flushesCompleted, this._flushesScheduled);
      })
      .catch((err) => {
        this._flushesCompleted++;
        this._flushError = err instanceof Error ? err : new Error(String(err));
      });
    this._inFlight.add(p);
    p.finally(() => this._inFlight.delete(p));
  }

  get flushesScheduled(): number { return this._flushesScheduled; }
  get flushesCompleted(): number { return this._flushesCompleted; }

  private async _runFlush(snapshot: FlushSnapshot): Promise<void> {
    const release = await this._flushSem.acquire();
    try {
      await this._doFlush(snapshot);
    } finally {
      release();
    }
  }

  private async _doFlush(snapshot: FlushSnapshot): Promise<void> {
    const { fileMetas, functions: allFunctions, classes: allClasses, calls: allCalls } = snapshot;

    const session = this.db.session();
    const tx = session.beginTransaction();
    try {
      const filePaths = fileMetas.map((m) => m.filePath);
      const deleteQ = batchDeleteFileChildren(filePaths);
      await tx.run(deleteQ.cypher, deleteQ.params);

      const fileItems = fileMetas.map((m) => ({
        path: m.filePath,
        relativePath: m.relativePath,
        repoPath: m.repoPath,
        language: m.language,
        hash: m.hash,
        lastModified: m.lastModified,
      }));
      const filesQ = batchUpsertFiles(fileItems);
      await tx.run(filesQ.cypher, filesQ.params);

      if (allClasses.length > 0) {
        const classItems = allClasses.map((c) => ({
          name: c.name,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          docstring: c.docstring,
        }));
        const classesQ = batchUpsertClasses(classItems);
        await tx.run(classesQ.cypher, classesQ.params);
      }

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
        await tx.run(fnsQ.cypher, fnsQ.params);
      }

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
        await tx.run(methodsQ.cypher, methodsQ.params);
      }

      if (allCalls.length > 0) {
        const callsQ = batchUpsertCallRelationships(allCalls);
        await tx.run(callsQ.cypher, callsQ.params);
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    } finally {
      await session.close();
    }
  }

  async flush(): Promise<void> {
    if (this._flushError) {
      const err = this._flushError;
      this._flushError = null;
      throw err;
    }

    // Flush any remaining buffered files
    if (this.fileMetas.length > 0) {
      this._scheduleFlush(this._snapshot());
    }

    // Drain all in-flight flushes
    while (this._inFlight.size > 0) {
      await Promise.all([...this._inFlight]);
    }

    if (this._flushError) {
      const err = this._flushError;
      this._flushError = null;
      throw err;
    }
  }

  // kept for API compatibility — flush() now drains everything
  async waitForPendingFlush(): Promise<void> {
    while (this._inFlight.size > 0) {
      await Promise.all([...this._inFlight]);
    }
  }

  get pendingFileCount(): number {
    return this.fileMetas.length;
  }

  get estimatedMemoryBytes(): number {
    return this._estimatedMemoryBytes;
  }
}
