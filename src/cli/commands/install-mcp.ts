import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import ora from "ora";

export async function runInstallMcp(): Promise<void> {
  const spinner = ora("Installing MCP server...").start();

  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  const mcpServers =
    (settings.mcpServers as Record<string, unknown>) || {};
  mcpServers["code-graph-rag"] = {
    command: "npx",
    args: ["code-graph-rag", "mcp-serve"],
    type: "stdio",
  };
  settings.mcpServers = mcpServers;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  spinner.succeed("MCP server registered in ~/.claude/settings.json");
}

export function registerInstallMcpCommand(program: Command): void {
  program
    .command("install-mcp")
    .description("Register the MCP server in Claude Code settings")
    .action(runInstallMcp);
}
