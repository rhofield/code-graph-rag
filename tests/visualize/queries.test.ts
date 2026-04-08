// tests/visualize/queries.test.ts
import { describe, it, expect } from "vitest";
import { INITIAL_LIMIT, EXPAND_FILE_LIMIT, EXPAND_FUNCTION_LIMIT, SEARCH_LIMIT } from "../../src/visualize/queries.js";

describe("visualize/queries — limits", () => {
  it("exports limit constants", () => {
    expect(INITIAL_LIMIT).toBe(500);
    expect(EXPAND_FILE_LIMIT).toBe(100);
    expect(EXPAND_FUNCTION_LIMIT).toBe(50);
    expect(SEARCH_LIMIT).toBe(25);
  });
});
