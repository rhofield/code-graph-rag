// src/cli/commands/init.ts
import { Command } from "commander";
import ora from "ora";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { setupSchema } from "../../db/schema.js";
import {
  isDockerAvailable,
  startNeo4j,
  waitForNeo4j,
} from "../../docker/neo4j.js";
import { printResolveResult, removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
import { indexRepository } from "../../indexer/index.js";
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { indexWorkspace } from "../../indexer/workspace.js";
import { startProgressHeartbeat } from "../progress.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runInit(): Promise<void> {
  const repoPath = resolve(".");
  const config = loadConfig(repoPath);
  const heartbeat = startProgressHeartbeat("Initializing rho-graph...");

  if (config.neo4j.managed) {
    heartbeat.update("Checking prerequisites...");
    const spinner = ora("Checking prerequisites...").start();
    if (!isDockerAvailable()) {
      spinner.fail(
        "Docker is not available. Install Docker or set neo4j.managed to false."
      );
      process.exit(1);
    }
    spinner.succeed("Docker available");

    heartbeat.update("Starting Neo4j...");
    const neo4jSpinner = ora("Starting Neo4j...").start();
    const composePath = resolve(__dirname, "../../../docker-compose.yml");
    startNeo4j(composePath);
    const ready = await waitForNeo4j(config.neo4j.uri, config.neo4j.username, config.neo4j.password);
    if (!ready) {
      neo4jSpinner.fail("Neo4j failed to start");
      process.exit(1);
    }
    neo4jSpinner.succeed("Neo4j running");
  }

  const db = createConnection(config.neo4j);
  heartbeat.update("Setting up schema...");
  const schemaSpinner = ora("Setting up schema...").start();
  await setupSchema(db);
  schemaSpinner.succeed("Schema ready");

  const resolved = await resolveRepos({
    workspaceRoot: repoPath,
    config,
    removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
  });
  printResolveResult(resolved);

  if (resolved.mode === "workspace") {
    const wsSpinner = ora(`Indexing workspace (${resolved.repos.length} repos)...`).start();
    heartbeat.update(`Indexing workspace (${resolved.repos.length} repos)...`);
    const result = await indexWorkspace(db, repoPath, resolved.repos, config.index, {
      onRepoStart: (name, _path, i, total) => {
        const message = `Indexing ${name} (${i + 1}/${total})...`;
        wsSpinner.text = message;
        heartbeat.update(message);
      },
      onProgress: (current, total, file) => {
        const message = `Parsing files... ${current}/${total} (${file})`;
        wsSpinner.text = message;
        heartbeat.update(message);
      },
      onFlushProgress: (completed, total) => {
        const message = `Writing to database... ${completed}/${total} batches`;
        wsSpinner.text = message;
        heartbeat.update(message);
      },
    });
    wsSpinner.succeed(
      `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ` +
        `${result.classesFound} classes, ${result.rpcEdgesCreated} RPC edges across ${result.repos.length} repos`
    );
    if (result.errors.length > 0) {
      console.log(`\n${result.errors.length} files had errors:`);
      for (const err of result.errors.slice(0, 100)) {
        console.log(`  ${err.file}: ${err.error}`);
      }
    }
  } else {
    const indexSpinner = ora("Indexing repository...").start();
    heartbeat.update("Indexing repository...");
    const result = await indexRepository(db, repoPath, config.index, {
      onProgress: (current, total, file) => {
        const message = `Indexing... ${current}/${total} (${file})`;
        indexSpinner.text = message;
        heartbeat.update(message);
      },
      onFlushProgress: (completed, total) => {
        const message = `Writing to database... ${completed}/${total} batches`;
        indexSpinner.text = message;
        heartbeat.update(message);
      },
    });
    indexSpinner.succeed(
      `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes`
    );
    if (result.errors.length > 0) {
      console.log(`\n${result.errors.length} files had errors:`);
      for (const err of result.errors.slice(0, 100)) {
        console.log(`  ${err.file}: ${err.error}`);
      }
    }
  }

  await db.close();
  heartbeat.stop();
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Neo4j and index the current repository (or workspace if configured)")
    .action(runInit);
}
