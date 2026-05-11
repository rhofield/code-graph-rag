import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

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
        let cypher = `
          MATCH (callee:Function {name: $functionName})
        `;
        const params: Record<string, unknown> = { functionName };
        if (filePath) {
          cypher += ` WHERE callee.filePath = $filePath`;
          params.filePath = filePath;
        }
        cypher += `
          MATCH (caller:Function)-[r:CALLS|RPC_CALLS]->(callee)
          RETURN caller.name AS callerName, caller.filePath AS callerFilePath,
                 caller.signature AS signature, caller.startLine AS startLine,
                 type(r) AS callType, r.serviceName AS rpcService, r.methodName AS rpcMethod
          ORDER BY callerFilePath, callerName
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
