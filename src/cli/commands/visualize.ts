// src/cli/commands/visualize.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { startVisualizationServer } from "../../visualize/server.js";

export function registerVisualizeCommand(program: Command): void {
  program
    .command("visualize")
    .description("Open browser-based graph visualization")
    .option("--repo <name>", "Filter by repository")
    .option("--file <path>", "Focus on a specific file")
    .option("--function <name>", "Focus on a specific function")
    .option("--port <port>", "Server port", "3333")
    .action(async (opts) => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);
      await startVisualizationServer({
        neo4jConfig: config.neo4j,
        port: parseInt(opts.port),
        filter: {
          repo: opts.repo,
          file: opts.file,
          function: opts.function,
        },
      });
    });
}
