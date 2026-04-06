import { Command } from "commander";

export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description("Install git post-commit hook")
    .action(async () => {
      console.log("install-hook: not yet implemented");
    });
}
