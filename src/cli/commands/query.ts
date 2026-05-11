// src/cli/commands/query.ts
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig } from "../../config.js";
import { createConnection, type DbConnection } from "../../db/connection.js";
import { functionCallersQuery } from "../../db/queries.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query [cypher]")
    .description(
      "Run Cypher queries against the graph (interactive REPL if no query given)"
    )
    .option("--callers <functionName>", "Find all callers of a function")
    .option("--dependencies <filePath>", "Find dependencies of a file")
    .option("--structure", "Show high-level repo structure")
    .option("-v, --verbose", "Show full query result values for agents")
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
        const q = functionCallersQuery({ functionName: opts.callers });
        cypher = q.cypher;
      } else if (opts.dependencies) {
        cypher =
          "MATCH (f:File)-[:IMPORTS]->(dep:File) WHERE f.relativePath = $path OR f.path ENDS WITH $path RETURN dep.relativePath AS dependency";
      } else if (opts.structure) {
        cypher =
          "MATCH (r:Repository)-[:CONTAINS_FILE]->(f:File) RETURN r.name AS repo, f.language AS language, count(f) AS files ORDER BY files DESC";
      }

      if (cypher) {
        const params: Record<string, unknown> = {};
        if (opts.callers) {
          Object.assign(params, functionCallersQuery({ functionName: opts.callers }).params);
        }
        if (opts.dependencies) params.path = opts.dependencies;
        await runQuery(db, cypher, params, Boolean(opts.verbose));
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
          await runQuery(db, trimmed, {}, Boolean(opts.verbose));
        }
        rl.prompt();
      });
    });
}

type Neo4jNodeLike = {
  labels: string[];
  properties: Record<string, unknown>;
};

type Neo4jRelationshipLike = {
  type: string;
  properties: Record<string, unknown>;
};

function formatVerboseValue(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNeo4jNodeLike(v: unknown): v is Neo4jNodeLike {
  return (
    isRecord(v) &&
    Array.isArray(v.labels) &&
    isRecord(v.properties)
  );
}

function isNeo4jRelationshipLike(v: unknown): v is Neo4jRelationshipLike {
  return (
    isRecord(v) &&
    typeof v.type === "string" &&
    isRecord(v.properties)
  );
}

function firstString(
  properties: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function formatLine(properties: Record<string, unknown>): string {
  const line = properties.startLine;
  return typeof line === "number" ? `:${line}` : "";
}

function summarizeNode(node: Neo4jNodeLike): string {
  const label = node.labels.join(":") || "Node";
  const properties = node.properties;
  const identifier =
    typeof properties.serviceName === "string" &&
    typeof properties.methodName === "string"
      ? `${properties.serviceName}.${properties.methodName}`
      : firstString(properties, [
          "name",
          "relativePath",
          "path",
          "filePath",
          "protoFile",
          "methodName",
          "serviceName",
        ]);
  const location = firstString(properties, ["relativePath", "filePath", "path"]);

  if (identifier && location && identifier !== location) {
    return `${label} ${identifier} (${location}${formatLine(properties)})`;
  }
  if (identifier) return `${label} ${identifier}`;
  if (location) return `${label} ${location}${formatLine(properties)}`;
  return label;
}

function summarizeRelationship(relationship: Neo4jRelationshipLike): string {
  const role = firstString(relationship.properties, ["role"]);
  return role ? `${relationship.type} (${role})` : relationship.type;
}

export function formatQueryValue(v: unknown, verbose: boolean): string {
  if (verbose) return formatVerboseValue(v);
  if (v == null || typeof v !== "object") return formatVerboseValue(v);
  if (Array.isArray(v)) {
    return `[${v.map((item) => formatQueryValue(item, false)).join(", ")}]`;
  }
  if (isNeo4jNodeLike(v)) return summarizeNode(v);
  if (isNeo4jRelationshipLike(v)) return summarizeRelationship(v);
  return formatVerboseValue(v);
}

function terminalWidth(): number {
  return process.stdout.columns ?? 120;
}

function printTable(keys: string[], rows: string[][]): void {
  const maxTotal = terminalWidth() - (keys.length - 1) * 3 - 4;
  const colWidths = keys.map((k, i) => {
    let max = k.length;
    for (const row of rows) {
      max = Math.max(max, row[i].length);
    }
    return max;
  });

  const totalNeeded = colWidths.reduce((a, b) => a + b, 0);
  if (totalNeeded > maxTotal) {
    const fair = Math.floor(maxTotal / keys.length);
    const narrow: number[] = [];
    let wideTotal = 0;
    let wideCount = 0;
    for (let i = 0; i < colWidths.length; i++) {
      if (colWidths[i] <= fair) {
        narrow.push(i);
      } else {
        wideTotal += colWidths[i];
        wideCount++;
      }
    }
    const narrowUsed = narrow.reduce((s, i) => s + colWidths[i], 0);
    const remaining = maxTotal - narrowUsed;
    const perWide = wideCount > 0 ? Math.floor(remaining / wideCount) : fair;
    for (let i = 0; i < colWidths.length; i++) {
      if (colWidths[i] > fair) {
        colWidths[i] = Math.max(perWide, 8);
      }
    }
  }

  const pad = (s: string, w: number) =>
    s.length <= w ? s + " ".repeat(w - s.length) : s.slice(0, w - 1) + "…";

  const header = keys.map((k, i) => pad(k, colWidths[i])).join(" │ ");
  const sep = colWidths.map((w) => "─".repeat(w)).join("─┼─");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((v, i) => pad(v, colWidths[i])).join(" │ "));
  }
  console.log(`\n${rows.length} row(s)`);
}

async function runQuery(
  db: DbConnection,
  cypher: string,
  params: Record<string, unknown>,
  verbose: boolean
): Promise<void> {
  const session = db.session();
  try {
    const result = await session.run(cypher, params);
    if (result.records.length === 0) {
      console.log("(no results)");
      return;
    }

    const keys = result.records[0].keys as string[];
    const rows = result.records.map((record) =>
      keys.map((k) => formatQueryValue(record.get(k), verbose))
    );
    printTable(keys, rows);
  } catch (error) {
    console.error(
      `Query error: ${error instanceof Error ? error.message : error}`
    );
  } finally {
    await session.close();
  }
}
