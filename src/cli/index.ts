// src/cli/index.ts
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerInstallMcpCommand } from "./commands/install-mcp.js";
import { registerInstallHookCommand } from "./commands/install-hook.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerVisualizeCommand } from "./commands/visualize.js";
import { registerDiscoverCommand } from "./commands/discover.js";

const program = new Command();

program
  .name("rho-graph")
  .description(
    "Graph-RAG code indexer — token-efficient code search for AI agents"
  )
  .version("0.1.0");

registerInitCommand(program);
registerIndexCommand(program);
registerStatusCommand(program);
registerSetupCommand(program);
registerInstallMcpCommand(program);
registerInstallHookCommand(program);
registerQueryCommand(program);
registerVisualizeCommand(program);
registerDiscoverCommand(program);

program
  .command("mcp-serve")
  .description("Start the MCP server (used by Claude Code)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/index.js");
    await startMcpServer();
  });

program.parse();
