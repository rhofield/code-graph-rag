// src/cli/commands/index-cmd.ts
import { Command } from "commander";
import ora from "ora";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
import { indexRepository } from "../../indexer/index.js";
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { indexWorkspace } from "../../indexer/workspace.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .description("Re-index the repository (or workspace if configured)")
    .option("--changed", "Only index changed files")
    .option("--path <path>", "Index a specific path")
    .option("--repo <repoPath>", "Index a different repository (disables workspace mode)")
    .option("--concurrency <n>", "Number of parallel parse tasks", "8")
    .option("--max-memory <mb>", "Max buffer memory in MB before backpressure", "8192")
    .action(async (opts) => {
      const workspaceRoot = resolve(opts.repo || ".");
      const config = loadConfig(workspaceRoot);
      const db = createConnection(config.neo4j);
      const concurrency = parseInt(opts.concurrency, 10);
      const maxMemoryMB = parseInt(opts.maxMemory, 10);

      let repos = config.repos;
      let useWorkspace = false;

      if (!opts.repo && !opts.path) {
        const resolved = await resolveRepos({
          workspaceRoot,
          config,
          removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
        });
        repos = resolved.repos;
        useWorkspace = resolved.mode === "workspace";
        if (resolved.warning) console.warn(resolved.warning);
        if (resolved.added.length > 0) console.log(`Discovered new repos: ${resolved.added.join(", ")}`);
        if (resolved.removed.length > 0) console.log(`Removed missing repos: ${resolved.removed.join(", ")}`);
      }

      if (useWorkspace) {
        const spinner = ora(`Indexing workspace (${repos.length} repos)...`).start();
        const result = await indexWorkspace(db, workspaceRoot, repos, config.index, {
          changedOnly: opts.changed,
          concurrency,
          maxMemoryMB,
          onRepoStart: (name, _path, i, total) => {
            spinner.text = `Indexing ${name} (${i + 1}/${total})...`;
          },
          onProgress: (current, total) => {
            spinner.text = `Parsing... ${current}/${total}`;
          },
        });
        const orphanSuffix =
          result.orphansRemoved > 0
            ? ` (removed ${result.orphansRemoved} orphaned files)`
            : "";
        spinner.succeed(
          `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ` +
            `${result.classesFound} classes, ${result.rpcEdgesCreated} RPC edges ` +
            `across ${result.repos.length} repos${orphanSuffix}`
        );
        if (result.errors.length > 0) {
          console.log(`\n${result.errors.length} files had errors:`);
          for (const err of result.errors.slice(0, 5)) {
            console.log(`  ${err.file}: ${err.error}`);
          }
        }
        await db.close();
        return;
      }

      const spinner = ora("Parsing files...").start();
      const result = await indexRepository(db, workspaceRoot, config.index, {
        changedOnly: opts.changed,
        specificPath: opts.path,
        concurrency,
        maxMemoryMB,
        onProgress: (current, total) => {
          spinner.text = `Parsing files... ${current}/${total}`;
        },
        onFlushProgress: (completed, total) => {
          spinner.text = `Writing to database... ${completed}/${total} batches`;
        },
      });
      const orphanSuffix =
        result.orphansRemoved > 0
          ? ` (removed ${result.orphansRemoved} orphaned files)`
          : "";
      spinner.succeed(
        `Indexed ${result.filesIndexed} files, ${result.functionsFound} functions, ${result.classesFound} classes${orphanSuffix}`
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
