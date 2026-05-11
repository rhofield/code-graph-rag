import { describe, it, expect, vi, beforeEach } from "vitest";
import { BatchGraphWriter } from "../../src/indexer/batch-writer.js";
import type { GraphEntities } from "../../src/indexer/extractor.js";
import type { FileMetadata } from "../../src/indexer/graph-writer.js";

const mockRun = vi.fn().mockResolvedValue({ records: [] });
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockTx = {
  run: mockRun,
  commit: vi.fn().mockResolvedValue(undefined),
  rollback: vi.fn().mockResolvedValue(undefined),
};
const mockSession = { beginTransaction: () => mockTx, close: mockClose };
const mockDb = {
  driver: {},
  session: () => mockSession,
  healthCheck: vi.fn(),
  close: vi.fn(),
};

function makeEntities(filePath = "/p/a.ts"): GraphEntities {
  return {
    functions: [{ name: "foo", filePath, startLine: 1, endLine: 3, signature: "fn foo()", docstring: null, snippet: "fn foo() {}", className: null }],
    classes: [{ name: "Bar", filePath, startLine: 5, endLine: 10, docstring: null }],
    imports: [],
    calls: [{ callerName: "foo", callerFilePath: filePath, calleeName: "baz" }],
    graphqlDocuments: [],
    graphqlUsages: [],
    graphqlFragmentSpreads: [],
  };
}

function makeMeta(filePath: string): FileMetadata {
  return {
    filePath,
    relativePath: filePath.replace("/p/", ""),
    repoPath: "/p",
    language: "typescript",
    hash: "abc123",
    lastModified: 1700000000,
  };
}

describe("BatchGraphWriter", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockClose.mockClear();
    mockTx.commit.mockClear();
    mockTx.rollback.mockClear();
  });

  it("does not write to Neo4j before flush is called", () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    writer.add(makeEntities(), makeMeta("/p/a.ts"));
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("flush() writes all accumulated entities via UNWIND queries", async () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    writer.add(makeEntities("/p/a.ts"), makeMeta("/p/a.ts"));
    writer.add(makeEntities("/p/b.ts"), makeMeta("/p/b.ts"));
    await writer.flush();
    expect(mockRun).toHaveBeenCalled();
    const cyphers = mockRun.mock.calls.map((c: any[]) => c[0] as string);
    expect(cyphers.some((c: string) => c.includes("UNWIND"))).toBe(true);
  });

  it("auto-flushes when batchSize is reached", async () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 2 });
    writer.add(makeEntities("/p/a.ts"), makeMeta("/p/a.ts"));
    writer.add(makeEntities("/p/b.ts"), makeMeta("/p/b.ts"));
    await writer.waitForPendingFlush();
    expect(mockRun).toHaveBeenCalled();
  });

  it("skips entities with empty names (pre-validation)", async () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    const entities: GraphEntities = {
      functions: [
        { name: "", filePath: "/p/a.ts", startLine: 1, endLine: 2, signature: "", docstring: null, snippet: "", className: null },
        { name: "valid", filePath: "/p/a.ts", startLine: 3, endLine: 5, signature: "fn valid()", docstring: null, snippet: "fn valid() {}", className: null },
      ],
      classes: [],
      imports: [],
      calls: [],
      graphqlDocuments: [],
      graphqlUsages: [],
      graphqlFragmentSpreads: [],
    };
    writer.add(entities, makeMeta("/p/a.ts"));
    await writer.flush();
    const fnCall = mockRun.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("UNWIND") && c[0].includes(":Function")
    );
    if (fnCall) {
      expect(fnCall[1].items).toHaveLength(1);
      expect(fnCall[1].items[0].name).toBe("valid");
    }
  });

  it("tracks pendingFileCount", () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    expect(writer.pendingFileCount).toBe(0);
    writer.add(makeEntities(), makeMeta("/p/a.ts"));
    expect(writer.pendingFileCount).toBe(1);
  });

  it("tracks estimatedMemoryBytes", () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    writer.add(makeEntities(), makeMeta("/p/a.ts"));
    expect(writer.estimatedMemoryBytes).toBeGreaterThan(0);
  });

  it("flush() writes GraphQL documents, usages, and fragment spreads", async () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    const filePath = "/p/UserCard.tsx";
    writer.add(
      {
        functions: [
          {
            name: "UserCard",
            filePath,
            startLine: 20,
            endLine: 25,
            signature: "function UserCard()",
            docstring: null,
            snippet: "function UserCard() { return useQuery(GET_USER); }",
            className: null,
          },
        ],
        classes: [],
        imports: [],
        calls: [],
        graphqlDocuments: [
          {
            name: "GetUser",
            kind: "query",
            filePath,
            startLine: 1,
            endLine: 8,
            signature: "query GetUser",
            snippet: "query GetUser { user { ...UserFields } }",
            variableName: "GET_USER",
            resolverFieldNames: ["user"],
          },
          {
            name: "UserFields",
            kind: "fragment",
            filePath,
            startLine: 10,
            endLine: 12,
            signature: "fragment UserFields",
            snippet: "fragment UserFields on User { id }",
            variableName: "USER_FIELDS",
            resolverFieldNames: [],
          },
        ],
        graphqlUsages: [
          {
            sourceName: "UserCard",
            sourceFilePath: filePath,
            documentName: "GetUser",
            documentFilePath: filePath,
          },
        ],
        graphqlFragmentSpreads: [
          {
            sourceDocumentName: "GetUser",
            sourceDocumentFilePath: filePath,
            targetFragmentName: "UserFields",
            targetFragmentFilePath: filePath,
          },
        ],
      },
      makeMeta(filePath)
    );

    await writer.flush();

    const cyphers = mockRun.mock.calls.map((c: any[]) => c[0] as string).join("\n");
    expect(cyphers).toContain("GraphQLDocument");
    expect(cyphers).toContain("USES_GRAPHQL");
    expect(cyphers).toContain("USES_FRAGMENT");
    expect(cyphers).toContain("USES_GRAPHQL_RESOLVER");
  });

  it("flush resets counters", async () => {
    const writer = new BatchGraphWriter(mockDb as any, { batchSize: 10 });
    writer.add(makeEntities(), makeMeta("/p/a.ts"));
    await writer.flush();
    expect(writer.pendingFileCount).toBe(0);
    expect(writer.estimatedMemoryBytes).toBe(0);
  });

  it("propagates auto-flush errors to the next flush()", async () => {
    const failRun = vi.fn().mockRejectedValue(new Error("DB connection failed"));
    const failTx = { run: failRun, commit: vi.fn().mockResolvedValue(undefined), rollback: vi.fn().mockResolvedValue(undefined) };
    const failSession = { beginTransaction: () => failTx, close: vi.fn().mockResolvedValue(undefined) };
    const failDb = { driver: {}, session: () => failSession, healthCheck: vi.fn(), close: vi.fn() };

    const writer = new BatchGraphWriter(failDb as any, { batchSize: 2 });
    writer.add(makeEntities("/p/a.ts"), makeMeta("/p/a.ts"));
    writer.add(makeEntities("/p/b.ts"), makeMeta("/p/b.ts")); // triggers auto-flush
    await writer.waitForPendingFlush(); // let the auto-flush reject

    await expect(writer.flush()).rejects.toThrow("DB connection failed");
  });
});
