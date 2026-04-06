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
# code-graph-rag: re-index changed files after commit
code-graph-rag index --changed &
`;

export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description("Install git post-commit hook for automatic re-indexing")
    .action(async () => {
      const spinner = ora("Installing git hook...").start();
      const repoRoot = resolve(".");
      const hookDir = join(repoRoot, ".git", "hooks");

      if (!existsSync(join(repoRoot, ".git"))) {
        spinner.fail("Not a git repository");
        process.exit(1);
      }

      const hookPath = join(hookDir, "post-commit");

      if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, "utf-8");
        if (existing.includes("code-graph-rag")) {
          spinner.succeed("Hook already installed");
          return;
        }
        writeFileSync(hookPath, existing + "\n" + HOOK_CONTENT);
      } else {
        writeFileSync(hookPath, HOOK_CONTENT);
      }

      chmodSync(hookPath, 0o755);
      spinner.succeed(`Hook installed at ${hookPath}`);
    });
}
