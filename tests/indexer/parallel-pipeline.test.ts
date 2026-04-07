import { describe, it, expect, vi } from "vitest";
import { Semaphore, runParallelPipeline } from "../../src/indexer/parallel-pipeline.js";
import type { PipelineResult } from "../../src/indexer/parallel-pipeline.js";

describe("Semaphore", () => {
  it("limits concurrency to the specified value", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async () => {
      const release = await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      release();
    };

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxRunning).toBe(2);
  });

  it("allows all tasks to complete", async () => {
    const sem = new Semaphore(3);
    let completed = 0;

    const task = async () => {
      const release = await sem.acquire();
      completed++;
      release();
    };

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(completed).toBe(5);
  });
});

describe("runParallelPipeline", () => {
  it("processes all files and returns correct counts", async () => {
    const parseFn = vi.fn().mockResolvedValue({
      tree: { rootNode: {} },
      language: "typescript",
      source: "const x = 1;",
    });
    const extractFn = vi.fn().mockReturnValue({
      functions: [{ name: "f", filePath: "/p/a.ts", startLine: 1, endLine: 2, signature: "fn f()", docstring: null, snippet: "fn f(){}", className: null }],
      classes: [],
      imports: [],
      calls: [],
    });

    const mockBatchWriter = {
      add: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      waitForPendingFlush: vi.fn().mockResolvedValue(undefined),
      get pendingFileCount() { return 0; },
      get estimatedMemoryBytes() { return 0; },
    };

    const result = await runParallelPipeline({
      files: ["/p/a.ts", "/p/b.ts", "/p/c.ts"],
      absRoot: "/p",
      concurrency: 2,
      maxMemoryBytes: 1024 * 1024 * 1024,
      parseFn,
      extractFn,
      batchWriter: mockBatchWriter as any,
      computeHashFn: () => "hash",
      getMtimeFn: () => 1700000000,
      onProgress: vi.fn(),
    });

    expect(parseFn).toHaveBeenCalledTimes(3);
    expect(mockBatchWriter.add).toHaveBeenCalledTimes(3);
    expect(mockBatchWriter.flush).toHaveBeenCalled();
    expect(result.filesIndexed).toBe(3);
    expect(result.functionsFound).toBe(3);
  });

  it("respects concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;

    const slowParse = vi.fn().mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { tree: { rootNode: {} }, language: "typescript", source: "x" };
    });

    await runParallelPipeline({
      files: ["/p/1.ts", "/p/2.ts", "/p/3.ts", "/p/4.ts", "/p/5.ts"],
      absRoot: "/p",
      concurrency: 2,
      maxMemoryBytes: 1024 * 1024 * 1024,
      parseFn: slowParse,
      extractFn: vi.fn().mockReturnValue({ functions: [], classes: [], imports: [], calls: [] }),
      batchWriter: { add: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), waitForPendingFlush: vi.fn().mockResolvedValue(undefined), get pendingFileCount() { return 0; }, get estimatedMemoryBytes() { return 0; } } as any,
      computeHashFn: () => "hash",
      getMtimeFn: () => 0,
      onProgress: vi.fn(),
    });

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("continues on parse errors and records them", async () => {
    const parseFn = vi.fn()
      .mockResolvedValueOnce({ tree: { rootNode: {} }, language: "typescript", source: "ok" })
      .mockRejectedValueOnce(new Error("parse fail"))
      .mockResolvedValueOnce({ tree: { rootNode: {} }, language: "typescript", source: "ok" });

    const result = await runParallelPipeline({
      files: ["/p/a.ts", "/p/b.ts", "/p/c.ts"],
      absRoot: "/p",
      concurrency: 1,
      maxMemoryBytes: 1024 * 1024 * 1024,
      parseFn,
      extractFn: vi.fn().mockReturnValue({ functions: [], classes: [], imports: [], calls: [] }),
      batchWriter: { add: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), waitForPendingFlush: vi.fn().mockResolvedValue(undefined), get pendingFileCount() { return 0; }, get estimatedMemoryBytes() { return 0; } } as any,
      computeHashFn: () => "hash",
      getMtimeFn: () => 0,
      onProgress: vi.fn(),
    });

    expect(result.filesIndexed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe("/p/b.ts");
  });

  it("triggers flush when memory limit exceeded (backpressure)", async () => {
    let memoryBytes = 0;
    const flushFn = vi.fn().mockImplementation(async () => { memoryBytes = 0; });

    const mockBatchWriter = {
      add: vi.fn().mockImplementation(() => { memoryBytes += 500 * 1024 * 1024; }),
      flush: flushFn,
      waitForPendingFlush: vi.fn().mockResolvedValue(undefined),
      get pendingFileCount() { return 0; },
      get estimatedMemoryBytes() { return memoryBytes; },
    };

    await runParallelPipeline({
      files: ["/p/a.ts", "/p/b.ts", "/p/c.ts"],
      absRoot: "/p",
      concurrency: 1,
      maxMemoryBytes: 1024 * 1024 * 1024,
      parseFn: vi.fn().mockResolvedValue({ tree: { rootNode: {} }, language: "typescript", source: "x" }),
      extractFn: vi.fn().mockReturnValue({ functions: [], classes: [], imports: [], calls: [] }),
      batchWriter: mockBatchWriter as any,
      computeHashFn: () => "hash",
      getMtimeFn: () => 0,
      onProgress: vi.fn(),
    });

    expect(flushFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onProgress for each file", async () => {
    const onProgress = vi.fn();

    await runParallelPipeline({
      files: ["/p/a.ts", "/p/b.ts"],
      absRoot: "/p",
      concurrency: 1,
      maxMemoryBytes: 1024 * 1024 * 1024,
      parseFn: vi.fn().mockResolvedValue({ tree: { rootNode: {} }, language: "typescript", source: "x" }),
      extractFn: vi.fn().mockReturnValue({ functions: [], classes: [], imports: [], calls: [] }),
      batchWriter: { add: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), waitForPendingFlush: vi.fn().mockResolvedValue(undefined), get pendingFileCount() { return 0; }, get estimatedMemoryBytes() { return 0; } } as any,
      computeHashFn: () => "hash",
      getMtimeFn: () => 0,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
