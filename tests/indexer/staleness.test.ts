// tests/indexer/staleness.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeFileHash, isFileStale, getChangedFilesSinceCommit, getCurrentCommitSha } from "../../src/indexer/staleness.js";

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

    it("accepts content string and returns matching hash", () => {
      const file = join(tempDir, "test.ts");
      const content = "const x = 1;";
      writeFileSync(file, content);
      const hashFromFile = computeFileHash(file);
      const hashFromContent = computeFileHash(file, content);
      expect(hashFromContent).toBe(hashFromFile);
    });

    it("computes hash from content without reading disk when content provided", () => {
      const hash = computeFileHash("/nonexistent/file.ts", "const x = 1;");
      expect(hash).toHaveLength(64); // SHA-256 hex
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

  describe("getChangedFilesSinceCommit", () => {
    it("accepts a base commit SHA parameter", () => {
      const result = getChangedFilesSinceCommit("/nonexistent-repo", "abc123");
      expect(result.changed).toEqual([]);
      expect(result.deleted).toEqual([]);
      // error: true is fine here
    });

    it("returns GitDiffResult shape with includeDeleted option", () => {
      const result = getChangedFilesSinceCommit("/nonexistent-repo", "HEAD~1", {
        includeDeleted: true,
      });
      expect(result).toHaveProperty("changed");
      expect(result).toHaveProperty("deleted");
      expect(Array.isArray(result.changed)).toBe(true);
      expect(Array.isArray(result.deleted)).toBe(true);
    });

    it("returns error:true when git command fails", () => {
      const result = getChangedFilesSinceCommit("/nonexistent-repo", "abc123");
      // /nonexistent-repo is not a git repo, so git fails
      expect(result.error).toBe(true);
      expect(result.changed).toEqual([]);
      expect(result.deleted).toEqual([]);
    });
  });

  describe("getCurrentCommitSha", () => {
    it("returns null for non-git directory", () => {
      const sha = getCurrentCommitSha("/nonexistent-repo");
      expect(sha).toBeNull();
    });
  });
});
