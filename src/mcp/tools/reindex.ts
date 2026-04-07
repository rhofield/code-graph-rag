import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";
import type { Config } from "../../config.js";
import { indexRepository } from "../../indexer/index.js";

export function registerReindex(
  server: McpServer,
  db: DbConnection,
  config: Config,
  repoPath: string
): void {
  server.tool(
    "reindex",
    "Trigger re-indexing of the repository or a specific path. Use this when you know files have changed and the graph may be stale.",
    {
      path: z.string().optional().describe("Specific path to reindex (defaults to changed files only)"),
    },
    async ({ path }) => {
      const result = await indexRepository(db, repoPath, config.index, {
        changedOnly: !path,
        specificPath: path,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                filesIndexed: result.filesIndexed,
                functionsFound: result.functionsFound,
                classesFound: result.classesFound,
                orphansRemoved: result.orphansRemoved,
                errors: result.errors.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
