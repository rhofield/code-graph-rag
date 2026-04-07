// src/cli/commands/visualize.ts
import { Command } from "commander";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ora from "ora";
import { loadConfig } from "../../config.js";
import { isDockerAvailable, startNeo4j, waitForNeo4j } from "../../docker/neo4j.js";
import { startVisualizationServer } from "../../visualize/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

      if (config.neo4j.managed) {
        if (!isDockerAvailable()) {
          console.error("Docker is not available. Install Docker or set neo4j.managed to false.");
          process.exit(1);
        }
        const spinner = ora("Starting Neo4j...").start();
        const composePath = resolve(__dirname, "../../../docker-compose.yml");
        startNeo4j(composePath);
        const ready = await waitForNeo4j(config.neo4j.uri, config.neo4j.username, config.neo4j.password);
        if (!ready) {
          spinner.fail("Neo4j failed to start");
          process.exit(1);
        }
        spinner.succeed("Neo4j running");
      }

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
