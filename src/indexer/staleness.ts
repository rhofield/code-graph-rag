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
  error?: boolean;  // true if git command failed
}

export function getChangedFilesSinceCommit(
  repoPath: string,
  baseSha?: string,
  options?: { includeDeleted?: boolean }
): GitDiffResult {
  const base = baseSha ?? "HEAD~1";
  try {
    if (options?.includeDeleted) {
      const output = execFileSync(
        "git",
        ["diff", "--name-status", `${base}..HEAD`],
        { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const changed: string[] = [];
      const deleted: string[] = [];
      for (const line of output.trim().split("\n").filter((l) => l.length > 0)) {
        const [status, ...rest] = line.split("\t");
        const filePath = rest.join("\t"); // handles paths with tabs (rare)
        if (status === "D") {
          deleted.push(filePath);
        } else {
          changed.push(filePath);
        }
      }
      return { changed, deleted };
    }

    const result = execFileSync(
      "git",
      ["diff", "--name-only", `${base}..HEAD`],
      { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter((f: string) => f.length > 0);

    return { changed: result, deleted: [] };
  } catch {
    return { changed: [], deleted: [], error: true };
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
