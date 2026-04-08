// src/visualize/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jConfig } from "../config.js";
import {
  repoOverview,
  filterByFile,
  filterByFunction,
  expandFile,
  expandFunction,
  searchByName,
  type CypherQuery,
} from "./queries.js";

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

async function runCypher(driver: Driver, q: CypherQuery): Promise<{ nodes: object[]; edges: object[] }> {
  const session = driver.session();
  try {
    const result = await session.run(q.cypher, q.params, { timeout: 10000 });
    const nodes = new Map<string, object>();
    const edges: object[] = [];

    for (const record of result.records) {
      for (const key of record.keys) {
        const val = record.get(key);
        if (val && typeof val === "object" && "identity" in val && "labels" in val) {
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
        if (val && typeof val === "object" && "type" in val && "start" in val && "end" in val) {
          edges.push({
            from: val.start.toString(),
            to: val.end.toString(),
            label: val.type,
          });
        }
      }
    }

    return { nodes: Array.from(nodes.values()), edges };
  } finally {
    await session.close();
  }
}

function pickInitialQuery(opts: VisualizationOptions, urlParams: URLSearchParams): CypherQuery {
  // URL params take precedence over CLI flags so the browser can re-query without restart
  const file = urlParams.get("file") ?? opts.filter.file;
  const fn = urlParams.get("function") ?? opts.filter.function;
  const repo = urlParams.get("repo") ?? opts.filter.repo;

  if (file) return filterByFile(file);
  if (fn) return filterByFunction(fn);
  return repoOverview(repo);
}

async function handleRequest(
  res: ServerResponse,
  url: string,
  driver: Driver,
  opts: VisualizationOptions
): Promise<void> {
  const parsedUrl = new URL(url, "http://localhost");
  const pathname = parsedUrl.pathname;
  const params = parsedUrl.searchParams;

  if (pathname === "/api/graph") {
    try {
      const data = await runCypher(driver, pickInitialQuery(opts, params));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/graph error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (pathname === "/api/expand") {
    const type = params.get("type");
    try {
      let q: CypherQuery;
      if (type === "file") {
        const filePath = params.get("filePath");
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing filePath" }));
          return;
        }
        q = expandFile(filePath);
      } else if (type === "function") {
        const name = params.get("name");
        const filePath = params.get("filePath");
        if (!name || !filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing name or filePath" }));
          return;
        }
        q = expandFunction(name, filePath);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown expand type: ${type}` }));
        return;
      }

      const data = await runCypher(driver, q);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/expand error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (pathname === "/api/search") {
    const q = params.get("q");
    if (!q) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing q" }));
      return;
    }
    try {
      const data = await runCypher(driver, searchByName(q));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[viz] /api/search error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Serve static files
  const publicDir = join(__dirname, "public");
  const filePath = join(publicDir, pathname === "/" ? "index.html" : pathname);
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
 * Test-only variant of startVisualizationServer:
 *   - returns the Server instance so tests can close it
 *   - does not call openBrowser
 *   - throws (does not process.exit) on connection failure
 */
export async function startVisualizationServerForTest(
  opts: VisualizationOptions
): Promise<import("node:http").Server> {
  const driver = neo4j.driver(
    opts.neo4jConfig.uri,
    neo4j.auth.basic(opts.neo4jConfig.username, opts.neo4jConfig.password),
    { connectionTimeout: 5000 }
  );

  const pingSession = driver.session();
  try {
    await pingSession.run("RETURN 1", {}, { timeout: 5000 });
  } finally {
    await pingSession.close();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    handleRequest(res, url, driver, opts).catch((err) => {
      console.error("[viz-test] unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal server error");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve(server));
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
