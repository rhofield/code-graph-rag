// src/cli/commands/query.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../../config.js";
import { createConnection, type DbConnection } from "../../db/connection.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query [cypher]")
    .description(
      "Run Cypher queries against the graph (interactive REPL if no query given)"
    )
    .option("--callers <functionName>", "Find all callers of a function")
    .option("--dependencies <filePath>", "Find dependencies of a file")
    .option("--structure", "Show high-level repo structure")
    .action(async (cypher, opts) => {
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

      if (opts.callers) {
        cypher =
          "MATCH (caller:Function)-[:CALLS]->(callee:Function {name: $name}) RETURN caller.name AS caller, caller.filePath AS file, caller.startLine AS line";
      } else if (opts.dependencies) {
        cypher =
          "MATCH (f:File)-[:IMPORTS]->(dep:File) WHERE f.relativePath = $path OR f.path ENDS WITH $path RETURN dep.relativePath AS dependency";
      } else if (opts.structure) {
        cypher =
          "MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File) RETURN r.name AS repo, f.language AS language, count(f) AS files ORDER BY files DESC";
      }

      if (cypher) {
        const params: Record<string, string> = {};
        if (opts.callers) params.name = opts.callers;
        if (opts.dependencies) params.path = opts.dependencies;
        await runQuery(db, cypher, params);
        await db.close();
        return;
      }

      // Interactive REPL
      console.log("rho-graph query REPL (type 'exit' to quit)\n");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "cypher> ",
      });

      rl.prompt();
      rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (trimmed === "exit" || trimmed === "quit") {
          await db.close();
          rl.close();
          return;
        }
        if (trimmed) {
          await runQuery(db, trimmed, {});
        }
        rl.prompt();
      });
    });
}

async function runQuery(
  db: DbConnection,
  cypher: string,
  params: Record<string, unknown>
): Promise<void> {
  const session = db.session();
  try {
    const result = await session.run(cypher, params);
    if (result.records.length === 0) {
      console.log("(no results)");
      return;
    }

    const keys = result.records[0].keys;
    console.log(keys.join("\t"));
    console.log(keys.map(() => "---").join("\t"));
    for (const record of result.records) {
      const values = keys.map((k) => {
        const v = record.get(k);
        return typeof v === "object" ? JSON.stringify(v) : String(v);
      });
      console.log(values.join("\t"));
    }
    console.log(`\n${result.records.length} row(s)`);
  } catch (error) {
    console.error(
      `Query error: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    await session.close();
  }
}
