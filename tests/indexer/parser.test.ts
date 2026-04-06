// tests/indexer/parser.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  initParser,
  parseFile,
  detectLanguage,
} from "../../src/indexer/parser.js";

describe("detectLanguage", () => {
  it("detects typescript from .ts extension", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
  });

  it("detects python from .py extension", () => {
    expect(detectLanguage("main.py")).toBe("python");
  });

  it("detects go from .go extension", () => {
    expect(detectLanguage("main.go")).toBe("go");
  });

  it("detects tsx from .tsx extension", () => {
    expect(detectLanguage("App.tsx")).toBe("tsx");
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("data.xyz")).toBeNull();
  });
});

describe("parseFile", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a TypeScript file and returns a result", async () => {
    const result = await parseFile("tests/fixtures/sample.ts");
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe("program");
    expect(result!.language).toBe("typescript");
  });

  it("parses a Python file and returns a result", async () => {
    const result = await parseFile("tests/fixtures/sample.py");
    expect(result).not.toBeNull();
    expect(result!.tree.rootNode.type).toBe("module");
    expect(result!.language).toBe("python");
  });

  it("returns null for unsupported file types", async () => {
    const result = await parseFile("tests/fixtures/unknown.xyz");
    expect(result).toBeNull();
  });
});
