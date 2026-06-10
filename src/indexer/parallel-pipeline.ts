import { relative } from "node:path";
import type Parser from "web-tree-sitter";
import type { BatchGraphWriter } from "./batch-writer.js";
import type { ProtoUsageAnnotation } from "./rpc-linker.js";

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
  onFlushProgress?: (completed: number, total: number) => void;
  rpcDetectFn?: (tree: Parser.Tree, language: string, source: string, filePath: string) => ProtoUsageAnnotation[];
}

export interface PipelineResult {
  filesIndexed: number;
  functionsFound: number;
  classesFound: number;
  errors: Array<{ file: string; error: string }>;
  rpcAnnotations: ProtoUsageAnnotation[];
}

export async function runParallelPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { files, absRoot, concurrency, maxMemoryBytes, parseFn, extractFn, batchWriter, computeHashFn, getMtimeFn, onProgress, onFlushProgress, rpcDetectFn } = options;
  if (onFlushProgress) batchWriter.onFlushProgress = onFlushProgress;

  const sem = new Semaphore(concurrency);
  const result: PipelineResult = { filesIndexed: 0, functionsFound: 0, classesFound: 0, errors: [], rpcAnnotations: [] };
  let progressCounter = 0;

  const tasks = files.map((file) => async () => {
    // Backpressure: flush BEFORE acquiring slot — fatal errors propagate out
    while (batchWriter.estimatedMemoryBytes >= maxMemoryBytes) {
      await batchWriter.flush();
    }

    const release = await sem.acquire();
    try {
      const parseResult = await parseFn(file);

      if (parseResult) {
        let entities: ReturnType<typeof extractFn>;
        try {
          entities = extractFn(parseResult.tree, parseResult.language, parseResult.source, file);
          if (rpcDetectFn) {
            const rpcAnns = rpcDetectFn(parseResult.tree, parseResult.language, parseResult.source, file);
            if (rpcAnns.length > 0) {
              result.rpcAnnotations.push(...rpcAnns);
            }
          }
        } finally {
          parseResult.tree.delete();
        }

        batchWriter.add(entities! as any, {
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
        result.functionsFound += entities!.functions.length;
        result.classesFound += entities!.classes.length;
      }
    } catch (error) {
      result.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
    } finally {
      progressCounter++;
      onProgress?.(progressCounter, files.length, file);
      release();
    }
  });

  await Promise.all(tasks.map((t) => t()));
  await batchWriter.waitForPendingFlush();
  await batchWriter.flush();

  return result;
}
