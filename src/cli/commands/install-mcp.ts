import { Command } from "commander";

export function registerInstallMcpCommand(program: Command): void {
  program
    .command("install-mcp")
    .description("Register MCP server in Claude Code config")
    .action(async () => {
      console.log("install-mcp: not yet implemented");
    });
}
