import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerSearchCode(server: McpServer, db: DbConnection): void {
  server.tool(
    "search_code",
    "Search for functions and classes by name, signature, or code content. Use this tool INSTEAD OF reading files directly when looking for code.",
    {
      query: z.string().describe("Search query — function name, keyword, or code fragment"),
      language: z.string().optional().describe("Filter by language (e.g. typescript, python)"),
      repo: z.string().optional().describe("Filter by repository path"),
      limit: z.number().optional().default(20).describe("Max results to return"),
    },
    async ({ query, language, repo, limit }) => {
      const session = db.session();
      try {
        let cypher = `
          CALL db.index.fulltext.queryNodes("code_search", $query)
          YIELD node, score
          WHERE (node:Function OR node:Class)
        `;
        const params: Record<string, unknown> = { query, limit: limit ?? 20 };
        if (language) {
          cypher += ` AND node.filePath ENDS WITH $languageExt`;
          params.languageExt = `.${language}`;
        }
        if (repo) {
          cypher += ` AND node.filePath STARTS WITH $repo`;
          params.repo = repo;
        }
        cypher += `
          RETURN node.name AS name, node.filePath AS filePath,
                 node.signature AS signature, node.snippet AS snippet,
                 node.startLine AS startLine, node.endLine AS endLine,
                 labels(node)[0] AS type, score
          ORDER BY score DESC LIMIT $limit
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
