// src/cli/commands/index-cmd.ts
import { Command } from "commander";
import ora from "ora";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import type { RepoEntry } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { printResolveResult, removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
import { indexRepository } from "../../indexer/index.js";
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { indexWorkspace } from "../../indexer/workspace.js";
import { startProgressHeartbeat } from "../progress.js";

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
      const heartbeat = startProgressHeartbeat("Preparing index...");

      let repos: RepoEntry[] = [];
      let useWorkspace = false;

      if (!opts.repo && !opts.path) {
        const resolved = await resolveRepos({
          workspaceRoot,
          config,
          removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
        });
        repos = resolved.repos;
        useWorkspace = resolved.mode === "workspace";
        printResolveResult(resolved);
      }

      if (useWorkspace) {
        const spinner = ora(`Indexing workspace (${repos.length} repos)...`).start();
        heartbeat.update(`Indexing workspace (${repos.length} repos)...`);
        const result = await indexWorkspace(db, workspaceRoot, repos, config.index, {
          changedOnly: opts.changed,
          concurrency,
          maxMemoryMB,
          onRepoStart: (name, _path, i, total) => {
            const message = `Indexing ${name} (${i + 1}/${total})...`;
            spinner.text = message;
            heartbeat.update(message);
          },
          onProgress: (current, total, file) => {
            const message = `Parsing... ${current}/${total} (${file})`;
            spinner.text = message;
            heartbeat.update(message);
          },
          onFlushProgress: (completed, total) => {
            const message = `Writing to database... ${completed}/${total} batches`;
            spinner.text = message;
            heartbeat.update(message);
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
        heartbeat.stop();
        return;
      }

      const spinner = ora("Parsing files...").start();
      heartbeat.update("Parsing files...");
      const result = await indexRepository(db, workspaceRoot, config.index, {
        changedOnly: opts.changed,
        specificPath: opts.path,
        concurrency,
        maxMemoryMB,
        onProgress: (current, total, file) => {
          const message = `Parsing files... ${current}/${total} (${file})`;
          spinner.text = message;
          heartbeat.update(message);
        },
        onFlushProgress: (completed, total) => {
          const message = `Writing to database... ${completed}/${total} batches`;
          spinner.text = message;
          heartbeat.update(message);
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
      heartbeat.stop();
    });
}
