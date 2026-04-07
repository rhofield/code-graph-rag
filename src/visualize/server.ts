// src/visualize/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import neo4j, { type Driver } from "neo4j-driver";
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

async function handleRequest(
  res: ServerResponse,
  url: string,
  driver: Driver,
  opts: VisualizationOptions
): Promise<void> {
  if (url === "/api/graph") {
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

      console.log("[viz] querying Neo4j...");
      const result = await session.run(cypher, { repo: opts.filter.repo }, { timeout: 10000 });

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

      console.log(`[viz] graph query OK: ${nodes.size} nodes, ${edges.length} edges`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ nodes: Array.from(nodes.values()), edges }));
    } catch (err) {
      console.error("[viz] graph query error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    } finally {
      await session.close();
    }
    return;
  }

  // Serve static files
  const publicDir = join(__dirname, "public");
  const filePath = join(publicDir, url === "/" ? "index.html" : url);
  console.log(`[viz] serving file: ${filePath}`);

  try {
    const content = readFileSync(filePath);
    const ext = filePath.endsWith(".js") ? "application/javascript" : "text/html";
    console.log(`[viz] -> 200 ${ext} (${content.length} bytes)`);
    res.writeHead(200, { "Content-Type": ext });
    res.end(content);
  } catch (err) {
    console.error(`[viz] -> 404: ${filePath}`, err instanceof Error ? err.message : err);
    res.writeHead(404);
    res.end("Not found");
  }
}

export async function startVisualizationServer(
  opts: VisualizationOptions
): Promise<void> {
  console.log(`[viz] connecting to Neo4j at ${opts.neo4jConfig.uri}...`);
  const driver = neo4j.driver(
    opts.neo4jConfig.uri,
    neo4j.auth.basic(opts.neo4jConfig.username, opts.neo4jConfig.password),
    { connectionTimeout: 5000 }
  );

  // Verify Neo4j is reachable before starting the HTTP server.
  try {
    const pingSession = driver.session();
    await pingSession.run("RETURN 1", {}, { timeout: 5000 });
    await pingSession.close();
    console.log("[viz] Neo4j connection OK");
  } catch (err) {
    console.error("[viz] Neo4j connection FAILED:", err);
    console.error(`[viz] Is Neo4j running at ${opts.neo4jConfig.uri}?`);
    await driver.close();
    process.exit(1);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    console.log(`[viz] ${req.method} ${url}`);

    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    handleRequest(res, url, driver, opts).catch((err) => {
      console.error("[viz] unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    });
  });

  server.on("connection", (socket) => {
    console.log(`[viz] TCP connection from ${socket.remoteAddress}:${socket.remotePort}`);
  });

  server.on("error", (err) => {
    console.error("[viz] server error:", err);
  });

  server.listen(opts.port, "0.0.0.0", () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`Graph visualization running at ${url}`);
    console.log(`[viz] listening on 0.0.0.0:${opts.port}`);
    console.log(`[viz] serving static files from: ${join(__dirname, "public")}`);
    openBrowser(url);
  });
}

/**
 * Launch the user's browser to `url` without ever blocking the Node event loop.
 *
 * Why this exists: the previous implementation used `execFileSync`, which holds
 * the main thread until the child exits. In WSL2 (and other headless Linux
 * environments) `xdg-open` can hang indefinitely searching for a browser, which
 * pins the event loop and starves the HTTP server of request callbacks even
 * though the TCP listener is bound. We MUST spawn detached + ignore stdio +
 * unref so this function returns immediately regardless of what the child does.
 */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === "win32") {
    // The empty "" is a placeholder window title — `start` interprets the
    // first quoted arg as a title, and omitting it breaks URLs with spaces.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (isWSL()) {
    // WSL2: hand off to the Windows default browser via cmd.exe.
    // The empty "" is `start`'s window-title placeholder (see win32 branch).
    // Falls back to a printed URL via the spawn `error` handler if cmd.exe
    // isn't on PATH (e.g. interop.appendWindowsPath=false in /etc/wsl.conf).
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      console.log(`Open your browser to: ${url}`);
    });
    child.unref();
  } catch {
    console.log(`Open your browser to: ${url}`);
  }
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const version = readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}
