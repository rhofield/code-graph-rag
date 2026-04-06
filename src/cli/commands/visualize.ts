import { Command } from "commander";

export function registerVisualizeCommand(program: Command): void {
  program
    .command("visualize")
    .description("Launch browser-based graph visualization")
    .action(async () => {
      console.log("visualize: not yet implemented");
    });
}
