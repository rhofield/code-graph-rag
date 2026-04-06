import { describe, it, expect } from "vitest";
import {
  batchUpsertFiles,
  batchUpsertFunctions,
  batchUpsertMethods,
  batchUpsertClasses,
  batchUpsertCallRelationships,
  batchDeleteFileChildren,
} from "../../src/db/queries.js";

describe("batch query builders", () => {
  it("batchUpsertFiles returns UNWIND cypher", () => {
    const items = [
      { path: "/p/a.ts", relativePath: "a.ts", repoPath: "/p", language: "typescript", hash: "h1", lastModified: 1 },
      { path: "/p/b.ts", relativePath: "b.ts", repoPath: "/p", language: "typescript", hash: "h2", lastModified: 2 },
    ];
    const { cypher, params } = batchUpsertFiles(items);
    expect(cypher).toContain("UNWIND $items AS item");
    expect(cypher).toContain("MERGE (f:File {path: item.path})");
    expect(params.items).toHaveLength(2);
  });

  it("batchUpsertFunctions returns UNWIND cypher for top-level functions", () => {
    const items = [
      { name: "foo", filePath: "/p/a.ts", startLine: 1, endLine: 5, signature: "fn foo()", docstring: null, snippet: "fn foo() {}", className: null },
    ];
    const { cypher, params } = batchUpsertFunctions(items);
    expect(cypher).toContain("UNWIND $items AS item");
    expect(cypher).toContain(":Function");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertMethods returns UNWIND cypher for class methods", () => {
    const items = [
      { name: "bar", filePath: "/p/a.ts", startLine: 1, endLine: 5, signature: "bar()", docstring: null, snippet: "bar() {}", className: "Foo" },
    ];
    const { cypher, params } = batchUpsertMethods(items);
    expect(cypher).toContain("UNWIND $items AS item");
    expect(cypher).toContain("HAS_METHOD");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertClasses returns UNWIND cypher", () => {
    const items = [
      { name: "Foo", filePath: "/p/a.ts", startLine: 1, endLine: 10, docstring: "A class" },
    ];
    const { cypher, params } = batchUpsertClasses(items);
    expect(cypher).toContain("UNWIND $items AS item");
    expect(cypher).toContain(":Class");
    expect(params.items).toHaveLength(1);
  });

  it("batchUpsertCallRelationships returns UNWIND cypher", () => {
    const items = [
      { callerName: "a", callerFilePath: "/p/a.ts", calleeName: "b" },
    ];
    const { cypher, params } = batchUpsertCallRelationships(items);
    expect(cypher).toContain("UNWIND $items AS item");
    expect(cypher).toContain("CALLS");
    expect(params.items).toHaveLength(1);
  });

  it("batchDeleteFileChildren returns UNWIND cypher", () => {
    const filePaths = ["/p/a.ts", "/p/b.ts"];
    const { cypher, params } = batchDeleteFileChildren(filePaths);
    expect(cypher).toContain("UNWIND $filePaths AS fp");
    expect(params.filePaths).toHaveLength(2);
  });
});
