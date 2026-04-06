import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetCallees(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_callees",
    "Find all functions that a specific function calls. Use this to understand what a function depends on.",
    {
      functionName: z.string().describe("Name of the function to find callees of"),
      filePath: z.string().optional().describe("Disambiguate by file path"),
    },
    async ({ functionName, filePath }) => {
      const session = db.session();
      try {
        let cypher = `
          MATCH (caller:Function {name: $functionName})
        `;
        const params: Record<string, unknown> = { functionName };
        if (filePath) {
          cypher += ` WHERE caller.filePath = $filePath`;
          params.filePath = filePath;
        }
        cypher += `
          MATCH (caller)-[:CALLS]->(callee:Function)
          RETURN callee.name AS calleeName, callee.filePath AS calleeFilePath,
                 callee.signature AS signature, callee.startLine AS startLine
          ORDER BY calleeFilePath, calleeName
        `;
        const result = await session.run(cypher, params);
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
