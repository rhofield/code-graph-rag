// src/indexer/staleness.ts
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function computeFileHash(filePath: string, content?: string | Buffer): string {
  const data = content ?? readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function getFileMtime(filePath: string): number {
  const stat = statSync(filePath);
  return stat.mtimeMs;
}

export function isFileStale(
  filePath: string,
  storedHash: string,
  storedMtime: number
): boolean {
  if (!existsSync(filePath)) {
    return true; // File was deleted
  }

  const currentMtime = getFileMtime(filePath);
  if (currentMtime <= storedMtime) {
    return false; // mtime hasn't changed, skip expensive hash
  }

  const currentHash = computeFileHash(filePath);
  return currentHash !== storedHash;
}

export interface GitDiffResult {
  changed: string[];
  deleted: string[];
}

export function getChangedFilesSinceCommit(
  repoPath: string,
  baseSha?: string,
  options?: { includeDeleted?: boolean }
): GitDiffResult {
  const base = baseSha ?? "HEAD~1";
  try {
    if (options?.includeDeleted) {
      const addedModified = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=ACM", `${base}..HEAD`],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim().split("\n").filter((f: string) => f.length > 0);

      const deleted = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=D", `${base}..HEAD`],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim().split("\n").filter((f: string) => f.length > 0);

      return { changed: addedModified, deleted };
    }

    const result = execFileSync(
      "git",
      ["diff", "--name-only", `${base}..HEAD`],
      { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter((f: string) => f.length > 0);

    return { changed: result, deleted: [] };
  } catch {
    return { changed: [], deleted: [] };
  }
}

export function getCurrentCommitSha(repoPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}
