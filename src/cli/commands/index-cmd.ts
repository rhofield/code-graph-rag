// src/cli/commands/index-cmd.ts
import { Command } from "commander";
import ora from "ora";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { indexRepository } from "../../indexer/index.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description("Re-index the repository")
    .option("--changed", "Only index changed files")
    .option("--path <path>", "Index a specific path")
    .option("--repo <repoPath>", "Index a different repository")
    .option("--concurrency <n>", "Number of parallel parse tasks", "8")
    .option("--max-memory <mb>", "Max buffer memory in MB before backpressure", "8192")
    .action(async (opts) => {
      const repoPath = resolve(opts.repo || ".");
      const config = loadConfig(repoPath);
      const db = createConnection(config.neo4j);

      const spinner = ora("Indexing...").start();
      const result = await indexRepository(db, repoPath, config.index, {
        changedOnly: opts.changed,
        specificPath: opts.path,
        concurrency: parseInt(opts.concurrency, 10),
        maxMemoryMB: parseInt(opts.maxMemory, 10),
        onProgress: (current, total) => {
          spinner.text = `Indexing... ${current}/${total}`;
        },
      });
      spinner.succeed(
        `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes`
      );

      if (result.errors.length > 0) {
        console.log(`\n${result.errors.length} files had errors:`);
        for (const err of result.errors.slice(0, 5)) {
          console.log(`  ${err.file}: ${err.error}`);
        }
      }

      await db.close();
    });
}
