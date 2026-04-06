import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetFileStructure(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_file_structure",
    "Get the structure of a file — classes and functions with their signatures but without code bodies. Much more efficient than reading the whole file.",
    {
      filePath: z.string().describe("Absolute or relative file path"),
    },
    async ({ filePath }) => {
      const session = db.session();
      try {
        const result = await session.run(
          `
          MATCH (f:File)
          WHERE f.path = $filePath OR f.relativePath = $filePath
          OPTIONAL MATCH (f)-[:CONTAINS]->(symbol)
          WHERE symbol:Function OR symbol:Class
          RETURN f.path AS filePath, f.language AS language,
                 collect({
                   type: labels(symbol)[0],
                   name: symbol.name,
                   signature: symbol.signature,
                   startLine: symbol.startLine,
                   endLine: symbol.endLine,
                   docstring: symbol.docstring
                 }) AS symbols
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
