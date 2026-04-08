// tests/visualize/queries.test.ts
import { describe, it, expect } from "vitest";
import { INITIAL_LIMIT, EXPAND_FILE_LIMIT, EXPAND_FUNCTION_LIMIT, SEARCH_LIMIT } from "../../src/visualize/queries.js";
import { repoOverview } from "../../src/visualize/queries.js";

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
