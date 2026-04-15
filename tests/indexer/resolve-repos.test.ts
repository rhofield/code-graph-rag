import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRepos } from "../../src/indexer/resolve-repos.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

function mkRepo(dir: string) { mkdirSync(join(dir, ".git"), { recursive: true }); }

describe("resolveRepos", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns [] when root is itself a git repo", async () => {
    mkRepo(root);
    const { repos, mode } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(repos).toEqual([]);
    expect(mode).toBe("single");
  });

  it("walks and writes .rho-graph.json when cache is missing", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const { repos, mode } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(mode).toBe("workspace");
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    const written = JSON.parse(readFileSync(join(root, ".rho-graph.json"), "utf-8"));
    expect(written.lastDiscoveredAt).toBe("2026-04-15T00:00:00.000Z");
    expect(written.repos.map((r: { path: string }) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("uses cache when fresh (within ttlHours)", async () => {
    mkRepo(join(root, "svc-a"));
    writeFileSync(
      join(root, ".rho-graph.json"),
      JSON.stringify({
        repos: [{ path: "svc-a", name: "my-custom-name" }],
        lastDiscoveredAt: "2026-04-15T00:00:00.000Z",
      })
    );
    // Add a second repo AFTER the cache was written — should not be picked up.
    mkRepo(join(root, "svc-b"));

    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: {
        ...DEFAULT_CONFIG,
        repos: [{ path: "svc-a", name: "my-custom-name" }],
        lastDiscoveredAt: "2026-04-15T00:00:00.000Z",
      },
      now: new Date("2026-04-15T12:00:00Z"), // 12h later
      removeRepoFromGraph: async () => {},
    });
    expect(repos.map((r) => r.path)).toEqual(["svc-a"]);
    expect(repos[0].name).toBe("my-custom-name");
  });

  it("re-walks when cache is stale", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: {
        ...DEFAULT_CONFIG,
        repos: [{ path: "svc-a", name: "keep-me" }],
        lastDiscoveredAt: "2026-04-14T00:00:00.000Z",
      },
      now: new Date("2026-04-15T12:00:00Z"), // 36h later, > 24h ttl
      removeRepoFromGraph: async () => {},
    });
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    expect(repos.find((r) => r.path === "svc-a")!.name).toBe("keep-me");
  });

  it("drops removed repos and invokes graph cleanup", async () => {
    // svc-a still present, svc-b had .git removed
    mkRepo(join(root, "svc-a"));
    mkdirSync(join(root, "svc-b"), { recursive: true });
    const removed: string[] = [];
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: {
        ...DEFAULT_CONFIG,
        repos: [{ path: "svc-a" }, { path: "svc-b" }],
        lastDiscoveredAt: "2026-04-14T00:00:00.000Z", // stale
      },
      now: new Date("2026-04-16T00:00:00Z"),
      removeRepoFromGraph: async (absPath) => { removed.push(absPath); },
    });
    expect(repos.map((r) => r.path)).toEqual(["svc-a"]);
    expect(removed).toEqual([join(root, "svc-b")]);
  });

  it("returns [] in single mode when no repos discovered under non-git root", async () => {
    const { repos, mode, warning } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(repos).toEqual([]);
    expect(mode).toBe("single");
    expect(warning).toMatch(/no.*repos.*discovered/i);
  });

  it("force: true bypasses TTL cache", async () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const { repos } = await resolveRepos({
      workspaceRoot: root,
      config: {
        ...DEFAULT_CONFIG,
        repos: [{ path: "svc-a" }],
        lastDiscoveredAt: "2026-04-15T00:00:00.000Z",
      },
      now: new Date("2026-04-15T01:00:00Z"), // would normally be fresh
      removeRepoFromGraph: async () => {},
      force: true,
    });
    expect(repos.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("short-circuits to single mode when root is a git worktree (.git is a file)", async () => {
    writeFileSync(join(root, ".git"), "gitdir: /some/other/path/worktrees/x\n");
    const { repos, mode, warning } = await resolveRepos({
      workspaceRoot: root,
      config: DEFAULT_CONFIG,
      now: new Date("2026-04-15T00:00:00Z"),
      removeRepoFromGraph: async () => {},
    });
    expect(repos).toEqual([]);
    expect(mode).toBe("single");
    expect(warning).toBeUndefined();
  });
});
