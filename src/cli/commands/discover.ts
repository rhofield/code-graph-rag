import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";
import { resolveRepos } from "../../indexer/resolve-repos.js";
import { removeRepoFromGraph } from "../../indexer/graph-cleanup.js";
import { discoverRepos } from "../../indexer/discover.js";

export function registerDiscoverCommand(program: Command): void {
  program
    .command("discover")
    .description("Walk the root for microservice subrepos and update .rho-graph.json")
    .option("--dry-run", "Show what would change without writing or touching the graph")
    .action(async (opts) => {
      const workspaceRoot = resolve(".");
      const config = loadConfig(workspaceRoot);

      if (opts.dryRun) {
        const discovered = discoverRepos(workspaceRoot, {
          exclude: config.index.exclude,
          maxDepth: config.discovery.maxDepth,
        });
        const existing = new Set(config.repos.map((r) => r.path));
        const discoveredSet = new Set(discovered.map((d) => d.path));
        const added = discovered.map((d) => d.path).filter((p) => !existing.has(p));
        const removed = config.repos.map((r) => r.path).filter((p) => !discoveredSet.has(p));
        console.log(`Discovered ${discovered.length} repos:`);
        for (const d of discovered) console.log(`  ${d.path}`);
        if (added.length) console.log(`Would add: ${added.join(", ")}`);
        if (removed.length) console.log(`Would remove: ${removed.join(", ")}`);
        if (!added.length && !removed.length) console.log("No changes.");
        return;
      }

      const db = createConnection(config.neo4j);
      try {
        const result = await resolveRepos({
          workspaceRoot,
          config,
          force: true,
          removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
        });
        if (result.warning) console.warn(result.warning);
        console.log(`Discovered ${result.repos.length} repos:`);
        for (const r of result.repos) console.log(`  ${r.path}`);
        if (result.added.length) console.log(`Added: ${result.added.join(", ")}`);
        if (result.removed.length) console.log(`Removed: ${result.removed.join(", ")}`);
      } finally {
        await db.close();
      }
    });
}
