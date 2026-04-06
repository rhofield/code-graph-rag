import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetClass(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_class",
    "Get a class definition with all its methods. Use this INSTEAD OF reading the file.",
    {
      name: z.string().describe("Class name"),
      filePath: z.string().optional().describe("File path for disambiguation"),
    },
    async ({ name, filePath }) => {
      const session = db.session();
      try {
        let cypher = `
          MATCH (c:Class {name: $name})
        `;
        const params: Record<string, unknown> = { name };
        if (filePath) {
          cypher += ` WHERE c.filePath = $filePath`;
          params.filePath = filePath;
        }
        cypher += `
          OPTIONAL MATCH (c)-[:HAS_METHOD]->(m:Function)
          RETURN c.name AS className, c.filePath AS filePath,
                 c.startLine AS startLine, c.endLine AS endLine,
                 c.docstring AS docstring,
                 collect({
                   name: m.name,
                   signature: m.signature,
                   snippet: m.snippet,
                   startLine: m.startLine,
                   endLine: m.endLine,
                   docstring: m.docstring
                 }) AS methods
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
