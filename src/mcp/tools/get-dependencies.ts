import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetDependencies(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_dependencies",
    "Get all files that a specific file imports. Use this to understand a file's dependencies.",
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
          MATCH (f)-[:IMPORTS]->(dep:File)
          RETURN dep.path AS dependencyPath, dep.relativePath AS relativePath,
                 dep.language AS language
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
