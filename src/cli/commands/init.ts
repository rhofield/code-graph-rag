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
import { indexRepository } from "../../indexer/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runInit(): Promise<void> {
  const repoPath = resolve(".");
  const config = loadConfig(repoPath);

  if (config.neo4j.managed) {
    const spinner = ora("Checking prerequisites...").start();
    if (!isDockerAvailable()) {
      spinner.fail(
        "Docker is not available. Install Docker or set neo4j.managed to false."
      );
      process.exit(1);
    }
    spinner.succeed("Docker available");

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
  const schemaSpinner = ora("Setting up schema...").start();
  await setupSchema(db);
  schemaSpinner.succeed("Schema ready");

  const indexSpinner = ora("Indexing repository...").start();
  const result = await indexRepository(db, repoPath, config.index, {
    onProgress: (current, total) => {
      indexSpinner.text = `Indexing... ${current}/${total}`;
    },
  });
  indexSpinner.succeed(
    `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes`
  );

  if (result.errors.length > 0) {
    console.log(`\n${result.errors.length} files had errors:`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`  ${err.file}: ${err.error}`);
    }
  }

  await db.close();
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Neo4j and index the current repository")
    .action(runInit);
}
