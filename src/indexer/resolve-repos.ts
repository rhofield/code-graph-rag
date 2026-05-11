import { resolve } from "node:path";
import type { Config, RepoEntry } from "../config.js";
import { saveConfig } from "../config.js";
import { discoverRepos, hasGitEntry } from "./discover.js";

export type ResolveMode = "workspace" | "single";

export interface ResolveReposArgs {
  workspaceRoot: string;
  config: Config;
  now?: Date;
  force?: boolean;
  removeRepoFromGraph: (absPath: string) => Promise<void>;
}

export interface ResolveReposResult {
  repos: RepoEntry[];
  mode: ResolveMode;
  added: string[];
  removed: string[];
  warning?: string;
}

function isCacheFresh(
  lastDiscoveredAt: string | undefined,
  ttlHours: number,
  now: Date
): boolean {
  if (!lastDiscoveredAt) return false;
  const last = Date.parse(lastDiscoveredAt);
  if (Number.isNaN(last)) return false;
  const ageMs = now.getTime() - last;
  return ageMs >= 0 && ageMs < ttlHours * 3600 * 1000;
}

export async function resolveRepos(args: ResolveReposArgs): Promise<ResolveReposResult> {
  const { workspaceRoot, config, removeRepoFromGraph } = args;
  const now = args.now ?? new Date();

  if (hasGitEntry(workspaceRoot)) {
    return { repos: [], mode: "single", added: [], removed: [] };
  }

  const fresh =
    !args.force &&
    config.repos.length > 0 &&
    isCacheFresh(config.lastDiscoveredAt, config.discovery.ttlHours, now);

  if (fresh) {
    return { repos: [...config.repos], mode: "workspace", added: [], removed: [] };
  }

  const discovered = discoverRepos(workspaceRoot, {
    exclude: config.index.exclude,
    maxDepth: config.discovery.maxDepth,
  });
  const discoveredPaths = new Set(discovered.map((d) => d.path));

  // Preserve user-set names for paths that still exist.
  const existingByPath = new Map(config.repos.map((r) => [r.path, r]));
  const merged: RepoEntry[] = discovered.map((d) => existingByPath.get(d.path) ?? { path: d.path, name: d.name });

  // Stored paths no longer discovered → removed.
  const removedEntries = config.repos.filter((r) => !discoveredPaths.has(r.path));
  const failedRemovals: { path: string; error: string }[] = [];
  for (const r of removedEntries) {
    try {
      await removeRepoFromGraph(resolve(workspaceRoot, r.path));
    } catch (err) {
      failedRemovals.push({ path: r.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Re-include failed removals in merged so the config keeps tracking them
  // (and we retry next run instead of silently dropping them from state).
  const failedPaths = new Set(failedRemovals.map((f) => f.path));
  if (failedPaths.size > 0) {
    for (const r of removedEntries) {
      if (failedPaths.has(r.path)) {
        merged.push(existingByPath.get(r.path) ?? { path: r.path });
      }
    }
  }

  const added = discovered
    .map((d) => d.path)
    .filter((p) => !existingByPath.has(p));
  const removed = removedEntries
    .filter((r) => !failedPaths.has(r.path))
    .map((r) => r.path);

  const warnings: string[] = [];
  if (failedRemovals.length > 0) {
    warnings.push(
      `Failed to remove from graph: ${failedRemovals.map((f) => f.path).join(", ")}. Will retry next run.`
    );
  }

  if (merged.length === 0) {
    warnings.unshift(
      `No git subrepos discovered under ${workspaceRoot}. Falling back to single-repo mode.`
    );
    return {
      repos: [],
      mode: "single",
      added,
      removed,
      warning: warnings.join(" "),
    };
  }

  saveConfig(workspaceRoot, {
    repos: merged,
    lastDiscoveredAt: now.toISOString(),
  });

  return {
    repos: merged,
    mode: "workspace",
    added,
    removed,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}
