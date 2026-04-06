import { describe, it, expect } from "vitest";
import { discoverFiles } from "../../src/indexer/index.js";

describe("discoverFiles", () => {
  it("discovers fixture files", async () => {
    const files = await discoverFiles("tests/fixtures", {
      include: ["**/*.ts", "**/*.py", "**/*.go", "**/*.graphql"],
      exclude: ["node_modules"],
      languages: "auto",
    });
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(".ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(".py"))).toBe(true);
    expect(files.some((f) => f.endsWith(".go"))).toBe(true);
  });

  it("respects exclude patterns", async () => {
    const files = await discoverFiles("tests/fixtures", {
      include: ["**/*.ts"],
      exclude: ["**/cross-file*"],
      languages: "auto",
    });
    expect(files.every((f) => !f.includes("cross-file"))).toBe(true);
  });
});
