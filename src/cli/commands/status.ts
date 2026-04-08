// src/cli/commands/status.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { createConnection } from "../../db/connection.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show index status")
    .action(async () => {
      const repoPath = resolve(".");
      const config = loadConfig(repoPath);
      const db = createConnection(config.neo4j);

      const healthy = await db.healthCheck();
      if (!healthy) {
        console.log(
          "Neo4j is not running. Run `rho-graph init` to start it."
        );
        process.exit(1);
      }

      const session = db.session();
      try {
        const repos = await session.run(
          "MATCH (r:Repository) RETURN r.name AS name, r.path AS path, r.lastIndexedAt AS lastIndexed"
        );
        const files = await session.run(
          "MATCH (f:File) RETURN f.language AS language, count(f) AS count"
        );
        const functions = await session.run(
          "MATCH (fn:Function) RETURN count(fn) AS count"
        );
        const classes = await session.run(
          "MATCH (c:Class) RETURN count(c) AS count"
        );

        console.log("\nRepositories:");
        for (const r of repos.records) {
          console.log(
            `  ${r.get("name")} (${r.get("path")}) — last indexed: ${r.get("lastIndexed")}`
          );
        }

        console.log("\nFiles by language:");
        for (const f of files.records) {
          console.log(`  ${f.get("language")}: ${f.get("count")}`);
        }

        console.log(
          `\nFunctions: ${functions.records[0]?.get("count") ?? 0}`
        );
        console.log(`Classes: ${classes.records[0]?.get("count") ?? 0}`);
      } finally {
        await session.close();
        await db.close();
      }
    });
}
