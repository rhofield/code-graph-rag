// tests/visualize/queries.test.ts
import { describe, it, expect } from "vitest";
import { INITIAL_LIMIT, EXPAND_FILE_LIMIT, EXPAND_FUNCTION_LIMIT, SEARCH_LIMIT } from "../../src/visualize/queries.js";
import { repoOverview, filterByFile, filterByFunction, expandFile, expandFunction } from "../../src/visualize/queries.js";

describe("visualize/queries — limits", () => {
  it("exports limit constants", () => {
    expect(INITIAL_LIMIT).toBe(500);
    expect(EXPAND_FILE_LIMIT).toBe(100);
    expect(EXPAND_FUNCTION_LIMIT).toBe(50);
    expect(SEARCH_LIMIT).toBe(25);
  });
});

describe("repoOverview", () => {
  it("returns repo + files + IMPORTS edges, no symbols", () => {
    const { cypher, params } = repoOverview();
    expect(cypher).toContain("MATCH (r:Repository)");
    expect(cypher).toContain(":CONTAINS_FILE");
    expect(cypher).toContain(":IMPORTS");
    expect(cypher).not.toContain(":Function");
    expect(cypher).not.toContain(":Class");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ repoName: null, limit: 500 });
  });

  it("filters by repo name when provided", () => {
    const { cypher, params } = repoOverview("my-service");
    expect(cypher).toContain("$repoName IS NULL OR r.name = $repoName");
    expect(params).toEqual({ repoName: "my-service", limit: 500 });
  });
});

describe("filterByFile", () => {
  it("returns the file + symbols + class methods", () => {
    const { cypher, params } = filterByFile("src/api.ts");
    expect(cypher).toContain("MATCH (f:File");
    expect(cypher).toContain("relativePath: $relativePath");
    expect(cypher).toContain(":CONTAINS");
    expect(cypher).toContain(":HAS_METHOD");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ relativePath: "src/api.ts", limit: 500 });
  });
});

describe("filterByFunction", () => {
  it("returns matching functions + containing files + 1-hop CALLS", () => {
    const { cypher, params } = filterByFunction("handleRequest");
    expect(cypher).toContain("MATCH (fn:Function {name: $name})");
    expect(cypher).toContain(":CONTAINS");
    expect(cypher).toContain(":CALLS");
    expect(cypher).toContain("LIMIT");
    expect(params).toEqual({ name: "handleRequest", limit: 500 });
  });
});

describe("expandFile", () => {
  it("returns symbols and class methods for a given absolute file path", () => {
    const { cypher, params } = expandFile("/abs/repo/src/api.ts");
    expect(cypher).toContain("MATCH (f:File {path: $filePath})");
    expect(cypher).toContain(":CONTAINS");
    expect(cypher).toContain(":HAS_METHOD");
    expect(params).toEqual({ filePath: "/abs/repo/src/api.ts", limit: EXPAND_FILE_LIMIT });
  });
});

describe("expandFunction", () => {
  it("returns 1-hop callers and callees, no further depth", () => {
    const { cypher, params } = expandFunction("handleRequest", "/abs/repo/src/api.ts");
    expect(cypher).toContain("MATCH (fn:Function {name: $name, filePath: $filePath})");
    expect(cypher).toContain("(fn)-[outCall:CALLS]->(callee:Function)");
    expect(cypher).toContain("(caller:Function)-[inCall:CALLS]->(fn)");
    // No 2-hop pattern like *2 or chained CALLS
    expect(cypher).not.toMatch(/CALLS\*[0-9]/);
    expect(params).toEqual({
      name: "handleRequest",
      filePath: "/abs/repo/src/api.ts",
      limit: EXPAND_FUNCTION_LIMIT,
    });
  });
});
