import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import ora from "ora";

function upsertMcpServer(filePath: string, dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    settings = JSON.parse(readFileSync(filePath, "utf-8"));
  }

  const mcpServers = (settings.mcpServers as Record<string, unknown>) || {};
  mcpServers["rho-graph"] = {
    command: "npx",
    args: ["rho-graph", "mcp-serve"],
    type: "stdio",
  };
  settings.mcpServers = mcpServers;

  writeFileSync(filePath, JSON.stringify(settings, null, 2));
}

export async function runInstallMcp(): Promise<void> {
  const spinner = ora("Installing MCP server...").start();

  const home = homedir();

  // Claude Code: ~/.claude/settings.json
  const claudeDir = join(home, ".claude");
  const claudeSettings = join(claudeDir, "settings.json");
  upsertMcpServer(claudeSettings, claudeDir);

  // Cursor: ~/.cursor/mcp.json
  const cursorDir = join(home, ".cursor");
  const cursorSettings = join(cursorDir, "mcp.json");
  upsertMcpServer(cursorSettings, cursorDir);

  spinner.succeed(
    "MCP server registered in ~/.claude/settings.json and ~/.cursor/mcp.json"
  );
}

export function registerInstallMcpCommand(program: Command): void {
  program
    .command("install-mcp")
    .description("Register the MCP server in Claude Code and Cursor settings")
    .action(runInstallMcp);
}
