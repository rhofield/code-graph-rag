// src/visualize/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import neo4j from "neo4j-driver";
import type { Neo4jConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VisualizationOptions {
  neo4jConfig: Neo4jConfig;
  port: number;
  filter: {
    repo?: string;
    file?: string;
    function?: string;
  };
}

export async function startVisualizationServer(
  opts: VisualizationOptions
): Promise<void> {
  const driver = neo4j.driver(
    opts.neo4jConfig.uri,
    neo4j.auth.basic(opts.neo4jConfig.username, opts.neo4jConfig.password)
  );

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";

    if (url === "/api/graph") {
      try {
        const session = driver.session();
        try {
          let cypher = `
            MATCH (n)
            WHERE n:Repository OR n:File OR n:Function OR n:Class
            OPTIONAL MATCH (n)-[r]->(m)
            WHERE m:Repository OR m:File OR m:Function OR m:Class
            RETURN n, r, m
            LIMIT 500
          `;

          if (opts.filter.repo) {
            cypher = `
              MATCH (repo:Repository {name: $repo})-[:CONTAINS_FILE]->(f:File)
              OPTIONAL MATCH (f)-[:CONTAINS]->(sym)
              OPTIONAL MATCH (sym)-[r]-(other)
              RETURN repo, f, sym, r, other
              LIMIT 500
            `;
          }

          const result = await session.run(cypher, { repo: opts.filter.repo });

          const nodes = new Map<string, object>();
          const edges: object[] = [];

          for (const record of result.records) {
            for (const key of record.keys) {
              const val = record.get(key);
              if (val && typeof val === "object" && "identity" in val) {
                const id = val.identity.toString();
                if (!nodes.has(id)) {
                  nodes.set(id, {
                    id,
                    label: val.properties.name || val.properties.relativePath || id,
                    group: val.labels?.[0] ?? "Unknown",
                    properties: val.properties,
                  });
                }
              }
              if (val && typeof val === "object" && "type" in val && "start" in val) {
                edges.push({
                  from: val.start.toString(),
                  to: val.end.toString(),
                  label: val.type,
                });
              }
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              nodes: Array.from(nodes.values()),
              edges,
            })
          );
        } finally {
          await session.close();
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // Serve static files
    const publicDir = join(__dirname, "public");
    const filePath = join(publicDir, url === "/" ? "index.html" : url);

    try {
      const content = readFileSync(filePath);
      const ext = filePath.endsWith(".js") ? "application/javascript" : "text/html";
      res.writeHead(200, { "Content-Type": ext });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(opts.port, () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`Graph visualization running at ${url}`);

    // Open browser
    try {
      const platform = process.platform;
      if (platform === "win32") {
        execFileSync("cmd", ["/c", "start", url]);
      } else if (platform === "darwin") {
        execFileSync("open", [url]);
      } else {
        execFileSync("xdg-open", [url]);
      }
    } catch {
      console.log(`Open your browser to: ${url}`);
    }
  });
}
