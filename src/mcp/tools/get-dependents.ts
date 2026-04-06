import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetDependents(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_dependents",
    "Get all files that import a specific file. Use this to understand what depends on a file before making changes.",
    {
      filePath: z.string().describe("Absolute or relative path of the file"),
    },
    async ({ filePath }) => {
      const session = db.session();
      try {
        const result = await session.run(
          `
          MATCH (f:File)
          WHERE f.path = $filePath OR f.relativePath = $filePath
          MATCH (dependent:File)-[:IMPORTS]->(f)
          RETURN dependent.path AS dependentPath, dependent.relativePath AS relativePath,
                 dependent.language AS language
          ORDER BY relativePath
          `,
          { filePath }
        );
        const records = result.records.map((r) => r.toObject());
        return {
          content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
        };
      } finally {
        await session.close();
      }
    }
  );
}
