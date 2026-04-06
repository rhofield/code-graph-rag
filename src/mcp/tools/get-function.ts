import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetFunction(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_function",
    "Get the full source code of a specific function by name. Use this INSTEAD OF reading the file to find a function.",
    {
      name: z.string().describe("Function name"),
      filePath: z.string().optional().describe("File path for disambiguation when multiple functions share a name"),
    },
    async ({ name, filePath }) => {
      const session = db.session();
      try {
        let cypher = `
          MATCH (fn:Function {name: $name})
        `;
        const params: Record<string, unknown> = { name };
        if (filePath) {
          cypher += ` WHERE fn.filePath = $filePath`;
          params.filePath = filePath;
        }
        cypher += `
          RETURN fn.name AS name, fn.filePath AS filePath,
                 fn.signature AS signature, fn.snippet AS snippet,
                 fn.startLine AS startLine, fn.endLine AS endLine,
                 fn.docstring AS docstring, fn.className AS className
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
