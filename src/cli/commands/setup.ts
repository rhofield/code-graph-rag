// src/cli/commands/setup.ts
import { Command } from "commander";
import { runInit } from "./init.js";
import { runInstallMcp } from "./install-mcp.js";
import { runInstallHook } from "./install-hook.js";

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Full setup: init + install MCP server + install git hook")
    .action(async () => {
      await runInit();
      await runInstallMcp();
      await runInstallHook();

      console.log(
        "\nReady! Your AI agent now has access to graph-powered code search."
      );
    });
}
