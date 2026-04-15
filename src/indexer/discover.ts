import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
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

function hasGitDir(p: string): boolean {
  try {
    const g = join(p, ".git");
    if (!existsSync(g)) return false;
    const s = statSync(g);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function discoverRepos(root: string, opts: DiscoverOptions): DiscoveredRepo[] {
  if (hasGitDir(root)) return [];

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

      if (hasGitDir(child)) {
        found.push({ path: relative(root, child), name: basename(child) });
        continue; // do not descend
      }
      queue.push({ abs: child, depth: depth + 1 });
    }
  }

  return found;
}
