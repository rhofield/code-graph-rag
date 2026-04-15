import { readdirSync, lstatSync } from "node:fs";
import { join, relative, basename } from "node:path";

export interface DiscoveredRepo {
  path: string; // relative to root
  name: string; // basename by default
}

export interface DiscoverOptions {
  exclude: string[];
  maxDepth: number;
}

function isDir(p: string): boolean {
  try {
    // Use lstat to avoid following symlinks
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return false;
    return s.isDirectory();
  } catch {
    return false;
  }
}

function hasGitEntry(p: string): boolean {
  try {
    const s = lstatSync(join(p, ".git"));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

export function discoverRepos(root: string, opts: DiscoverOptions): DiscoveredRepo[] {
  if (hasGitEntry(root)) return [];

  const found: DiscoveredRepo[] = [];
  const excludeSet = new Set(opts.exclude);
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];

  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!;
    if (depth >= opts.maxDepth) continue;

    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (excludeSet.has(name)) continue;
      const child = join(abs, name);
      if (!isDir(child)) continue;

      if (hasGitEntry(child)) {
        found.push({ path: relative(root, child), name: basename(child) });
        continue; // do not descend
      }
      queue.push({ abs: child, depth: depth + 1 });
    }
  }

  return found;
}
