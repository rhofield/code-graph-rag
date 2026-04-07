import { relative } from "node:path";
import type { BatchGraphWriter } from "./batch-writer.js";

export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface PipelineOptions {
  files: string[];
  absRoot: string;
  concurrency: number;
  maxMemoryBytes: number;
  parseFn: (filePath: string) => Promise<{ tree: any; language: string; source: string } | null>;
  extractFn: (tree: any, language: string, source: string, filePath: string) => { functions: any[]; classes: any[]; imports: any[]; calls: any[] };
  batchWriter: BatchGraphWriter;
  computeHashFn: (filePath: string, content?: string) => string;
  getMtimeFn: (filePath: string) => number;
  onProgress?: (current: number, total: number, file: string) => void;
}

export interface PipelineResult {
  filesIndexed: number;
  functionsFound: number;
  classesFound: number;
  errors: Array<{ file: string; error: string }>;
}

export async function runParallelPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { files, absRoot, concurrency, maxMemoryBytes, parseFn, extractFn, batchWriter, computeHashFn, getMtimeFn, onProgress } = options;

  const sem = new Semaphore(concurrency);
  const result: PipelineResult = { filesIndexed: 0, functionsFound: 0, classesFound: 0, errors: [] };
  let progressCounter = 0;

  const tasks = files.map((file) => async () => {
    const release = await sem.acquire();
    try {
      // Backpressure: wait for flush if memory limit exceeded
      while (batchWriter.estimatedMemoryBytes >= maxMemoryBytes) {
        await batchWriter.flush();
      }

      const parseResult = await parseFn(file);
      progressCounter++;
      onProgress?.(progressCounter, files.length, file);

      if (!parseResult) return;

      const entities = extractFn(parseResult.tree, parseResult.language, parseResult.source, file);

      batchWriter.add(entities as any, {
        filePath: file,
        relativePath: relative(absRoot, file),
        repoPath: absRoot,
        language: parseResult.language,
        hash: computeHashFn(file, parseResult.source),
        lastModified: getMtimeFn(file),
      });

      // Backpressure: flush if memory limit exceeded after add
      if (batchWriter.estimatedMemoryBytes >= maxMemoryBytes) {
        await batchWriter.flush();
      }

      result.filesIndexed++;
      result.functionsFound += entities.functions.length;
      result.classesFound += entities.classes.length;
    } catch (error) {
      progressCounter++;
      onProgress?.(progressCounter, files.length, file);
      result.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  });

  await Promise.all(tasks.map((t) => t()));
  await batchWriter.waitForPendingFlush();
  await batchWriter.flush();

  return result;
}
