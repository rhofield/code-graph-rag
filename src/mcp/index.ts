// src/mcp/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createConnection } from "../db/connection.js";
import { registerSearchCode } from "./tools/search-code.js";
import { registerGetFunction } from "./tools/get-function.js";
import { registerGetClass } from "./tools/get-class.js";
import { registerGetFileStructure } from "./tools/get-file-structure.js";
import { registerGetCallers } from "./tools/get-callers.js";
import { registerGetCallees } from "./tools/get-callees.js";
import { registerGetDependencies } from "./tools/get-dependencies.js";
import { registerGetDependents } from "./tools/get-dependents.js";
import { registerGetRepoStructure } from "./tools/get-repo-structure.js";
import { registerReindex } from "./tools/reindex.js";

export async function startMcpServer(): Promise<void> {
  const repoPath = resolve(".");
  const config = loadConfig(repoPath);
  const db = createConnection(config.neo4j);

  const server = new McpServer({
    name: "code-graph-rag",
    version: "0.1.0",
  });

  registerSearchCode(server, db);
  registerGetFunction(server, db);
  registerGetClass(server, db);
  registerGetFileStructure(server, db);
  registerGetCallers(server, db);
  registerGetCallees(server, db);
  registerGetDependencies(server, db);
  registerGetDependents(server, db);
  registerGetRepoStructure(server, db);
  registerReindex(server, db, config, repoPath);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
