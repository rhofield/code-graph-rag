// src/indexer/staleness.ts
import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
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

export function getChangedFilesSinceCommit(repoPath: string): string[] {
  try {
    const result = execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result
      .trim()
      .split("\n")
      .filter((f: string) => f.length > 0);
  } catch {
    return [];
  }
}
