import { resolve, basename } from "node:path";
import type { DbConnection } from "../db/connection.js";
import type { IndexConfig, RepoEntry } from "../config.js";
import { createProtoRegistry } from "./proto-registry.js";
import { indexRepository, discoverFiles, type IndexResult } from "./index.js";
import { parseProtoFiles } from "./proto-parser.js";
import { linkGraphQLResolverEdges } from "./graphql-linker.js";

export interface WorkspaceRepoResult extends IndexResult {
  repoPath: string;
  repoName: string;
}

export interface WorkspaceResult {
  repos: WorkspaceRepoResult[];
  filesIndexed: number;
  functionsFound: number;
  classesFound: number;
  rpcEdgesCreated: number;
  orphansRemoved: number;
  errors: Array<{ file: string; error: string }>;
}

export interface WorkspaceOptions {
  changedOnly?: boolean;
  concurrency?: number;
  maxMemoryMB?: number;
  onRepoStart?: (repoName: string, repoPath: string, index: number, total: number) => void;
  onProgress?: (current: number, total: number, file: string) => void;
  onFlushProgress?: (completed: number, total: number) => void;
}

/**
 * Index multiple repositories as a single workspace with a shared ProtoRegistry.
 * Paths in `repos` may be absolute or relative to `workspaceRoot`. A shared
 * in-memory registry means proto definitions discovered in any repo are visible
 * to the RPC detector in every repo of the same run, regardless of ordering.
 */
export async function indexWorkspace(
  db: DbConnection,
  workspaceRoot: string,
  repos: RepoEntry[],
  config: IndexConfig,
  options: WorkspaceOptions = {}
): Promise<WorkspaceResult> {
  const registry = createProtoRegistry();
  const absRoot = resolve(workspaceRoot);
  const results: WorkspaceRepoResult[] = [];

  // Pre-scan every repo's .proto files into the shared registry before any
  // repo is indexed. Per-repo detection runs while repos index, so without
  // this a caller/resolver repo indexed before the proto repo would see an
  // empty registry and silently produce no annotations.
  for (const entry of repos) {
    const repoPath = resolve(absRoot, entry.path);
    const files = await discoverFiles(repoPath, config);
    const protoFiles = files.filter((f) => f.endsWith(".proto"));
    if (protoFiles.length > 0) parseProtoFiles(protoFiles, registry);
  }

  for (let i = 0; i < repos.length; i++) {
    const entry = repos[i];
    const repoPath = resolve(absRoot, entry.path);
    const repoName = entry.name ?? basename(repoPath);
    options.onRepoStart?.(repoName, repoPath, i, repos.length);
    const r = await indexRepository(db, repoPath, config, {
      changedOnly: options.changedOnly,
      concurrency: options.concurrency,
      maxMemoryMB: options.maxMemoryMB,
      protoRegistry: registry,
      deferGraphQLResolverLinking: true,
      onProgress: options.onProgress,
      onFlushProgress: options.onFlushProgress,
    });
    results.push({ ...r, repoPath, repoName });
  }

  const touchedFilePaths = results.flatMap((r) => r.touchedFilePaths);
  if (touchedFilePaths.length > 0) {
    await linkGraphQLResolverEdges(db, touchedFilePaths);
  }

  return {
    repos: results,
    filesIndexed: results.reduce((s, r) => s + r.filesIndexed, 0),
    functionsFound: results.reduce((s, r) => s + r.functionsFound, 0),
    classesFound: results.reduce((s, r) => s + r.classesFound, 0),
    rpcEdgesCreated: results.reduce((s, r) => s + r.rpcEdgesCreated, 0),
    orphansRemoved: results.reduce((s, r) => s + r.orphansRemoved, 0),
    errors: results.flatMap((r) => r.errors),
  };
}
