import { Command } from "commander";

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Interactive Cypher REPL and query shortcuts")
    .action(async () => {
      console.log("query: not yet implemented");
    });
}
