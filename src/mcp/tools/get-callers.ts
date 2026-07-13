import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";
import { functionCallersQuery } from "../../db/queries.js";

export function registerGetCallers(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_callers",
    "Find all functions that call a specific function, including cross-service RPC callers. Use this to understand who depends on a function across the entire call graph.",
    {
      functionName: z.string().describe("Name of the function to find callers of"),
      filePath: z.string().optional().describe("Disambiguate by file path"),
    },
    async ({ functionName, filePath }) => {
      const session = db.session();
      try {
        const q = functionCallersQuery({ functionName, filePath });
        const result = await session.run(q.cypher, q.params);
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
