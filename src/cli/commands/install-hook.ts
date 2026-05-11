import { Command } from "commander";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import ora from "ora";

const HOOK_CONTENT = `#!/bin/sh
# rho-graph: re-index changed files after commit
rho-graph index --changed &
`;

export async function runInstallHook(): Promise<void> {
  const spinner = ora("Installing git hook...").start();
  const repoRoot = resolve(".");
  const hookDir = join(repoRoot, ".git", "hooks");

  if (!existsSync(join(repoRoot, ".git"))) {
    spinner.warn("Not a git repository — skipping hook install");
    return;
  }

  const hookPath = join(hookDir, "post-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes("rho-graph")) {
      spinner.succeed("Hook already installed");
      return;
    }
    writeFileSync(hookPath, existing + "\n" + HOOK_CONTENT);
  } else {
    writeFileSync(hookPath, HOOK_CONTENT);
  }

  chmodSync(hookPath, 0o755);
  spinner.succeed(`Hook installed at ${hookPath}`);
}

export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description("Install git post-commit hook for automatic re-indexing")
    .action(runInstallHook);
}
