import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeGraphEntities } from "../../src/indexer/graph-writer.js";
import type { GraphEntities } from "../../src/indexer/extractor.js";

const mockRun = vi.fn().mockResolvedValue({ records: [] });
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSession = { run: mockRun, close: mockClose };
const mockDb = {
  driver: {},
  session: () => mockSession,
  healthCheck: vi.fn(),
  close: vi.fn(),
};

describe("writeGraphEntities", () => {
  beforeEach(() => {
    mockRun.mockClear();
  });

  it("writes repository, file, functions, classes, and calls", async () => {
    const entities: GraphEntities = {
      functions: [
        {
          name: "greet",
          filePath: "/project/src/index.ts",
          startLine: 1,
          endLine: 3,
          signature: "function greet(name: string): string",
          docstring: "Greets a user",
          snippet: "function greet(name: string) { return 'hi'; }",
          className: null,
        },
      ],
      classes: [
        {
          name: "UserService",
          filePath: "/project/src/index.ts",
          startLine: 5,
          endLine: 20,
          docstring: "User ops",
        },
      ],
      imports: [],
      calls: [
        {
          callerName: "greet",
          callerFilePath: "/project/src/index.ts",
          calleeName: "validate",
        },
      ],
    };

    await writeGraphEntities(mockDb as any, entities, {
      filePath: "/project/src/index.ts",
      relativePath: "src/index.ts",
      repoPath: "/project",
      language: "typescript",
      hash: "abc123",
      lastModified: 1700000000,
    });

    // Should have run queries for: repo, file, delete old children, re-link file, class, function, call
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("handles empty entities without error", async () => {
    const entities: GraphEntities = {
      functions: [],
      classes: [],
      imports: [],
      calls: [],
    };

    await writeGraphEntities(mockDb as any, entities, {
      filePath: "/project/src/empty.ts",
      relativePath: "src/empty.ts",
      repoPath: "/project",
      language: "typescript",
      hash: "def456",
      lastModified: 1700000000,
    });

    // Should still write repo and file nodes
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
