// tests/indexer/staleness.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFileHash, isFileStale } from "../../src/indexer/staleness.js";

describe("staleness detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cgr-stale-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeFileHash", () => {
    it("returns consistent hash for same content", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const hash1 = computeFileHash(file);
      const hash2 = computeFileHash(file);
      expect(hash1).toBe(hash2);
    });

    it("returns different hash for different content", () => {
      const file1 = join(tempDir, "a.ts");
      const file2 = join(tempDir, "b.ts");
      writeFileSync(file1, "const x = 1;");
      writeFileSync(file2, "const x = 2;");
      expect(computeFileHash(file1)).not.toBe(computeFileHash(file2));
    });
  });

  describe("isFileStale", () => {
    it("returns true when hash differs", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const oldHash = computeFileHash(file);
      writeFileSync(file, "const x = 2;");
      expect(isFileStale(file, oldHash, 0)).toBe(true);
    });

    it("returns false when hash matches", () => {
      const file = join(tempDir, "test.ts");
      writeFileSync(file, "const x = 1;");
      const hash = computeFileHash(file);
      expect(isFileStale(file, hash, Date.now())).toBe(false);
    });

    it("returns true when file does not exist (deleted)", () => {
      expect(isFileStale("/nonexistent/file.ts", "abc", 0)).toBe(true);
    });
  });
});
