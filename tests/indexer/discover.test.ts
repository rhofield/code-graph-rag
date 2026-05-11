import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverRepos } from "../../src/indexer/discover.js";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mkRepo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

describe("discoverRepos", () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `discover-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds git subrepos at depth 1", () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-b"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path).sort()).toEqual(["svc-a", "svc-b"]);
    expect(found[0].name).toBe(found[0].path); // defaults to basename
  });

  it("does not descend into found repos", () => {
    mkRepo(join(root, "svc-a"));
    mkRepo(join(root, "svc-a", "nested-repo"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["svc-a"]);
  });

  it("finds nested repos at deeper levels", () => {
    mkRepo(join(root, "group", "svc-a"));
    mkRepo(join(root, "group", "svc-b"));
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path).sort()).toEqual(["group/svc-a", "group/svc-b"]);
  });

  it("skips excluded directory names", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkRepo(join(root, "node_modules", "pkg"));
    mkRepo(join(root, "svc-a"));
    const found = discoverRepos(root, { exclude: ["node_modules"], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["svc-a"]);
  });

  it("respects maxDepth", () => {
    mkRepo(join(root, "a", "b", "c", "svc"));
    const shallow = discoverRepos(root, { exclude: [], maxDepth: 2 });
    expect(shallow).toEqual([]);
    const deeper = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(deeper.map((r) => r.path)).toEqual(["a/b/c/svc"]);
  });

  it("does not follow symlinks", () => {
    mkRepo(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"), "dir");
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["real"]);
  });

  it("returns empty when root itself has .git (caller's responsibility to short-circuit)", () => {
    mkRepo(root);
    mkRepo(join(root, "svc-a")); // shouldn't be reported — we don't descend into root because root is a repo
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found).toEqual([]);
  });

  it("treats .git as a file (worktree case) as a valid repo", () => {
    const svc = join(root, "worktree-svc");
    mkdirSync(svc, { recursive: true });
    writeFileSync(join(svc, ".git"), "gitdir: /some/other/path/worktrees/x\n");
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["worktree-svc"]);
  });

  it("tolerates broken symlinks during walk", () => {
    mkRepo(join(root, "real"));
    symlinkSync("/nonexistent-target-xyz", join(root, "dangle"), "dir");
    const found = discoverRepos(root, { exclude: [], maxDepth: 6 });
    expect(found.map((r) => r.path)).toEqual(["real"]);
  });
});
