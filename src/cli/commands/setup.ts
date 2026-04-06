// src/cli/commands/setup.ts
import { Command } from "commander";

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Full setup: init + install MCP server + install git hook")
    .action(async () => {
      // Sequentially invoke subcommands
      await parent.parseAsync(["node", "code-graph-rag", "init"], {
        from: "user",
      });
      await parent.parseAsync(["node", "code-graph-rag", "install-mcp"], {
        from: "user",
      });
      await parent.parseAsync(["node", "code-graph-rag", "install-hook"], {
        from: "user",
      });

      console.log(
        "\nReady! Your AI agent now has access to graph-powered code search."
      );
    });
}
