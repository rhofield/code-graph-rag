import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DbConnection } from "../../db/connection.js";

export function registerGetRepoStructure(server: McpServer, db: DbConnection): void {
  server.tool(
    "get_repo_structure",
    "Get a bird's-eye view of a repository — file counts by directory and top-level symbols. Use this to orient yourself in a new codebase.",
    {
      repo: z.string().optional().describe("Repository path to query (defaults to all repos)"),
      depth: z.number().optional().default(3).describe("Directory depth to show"),
    },
    async ({ repo, depth }) => {
      const session = db.session();
      try {
        let cypher = `
          MATCH (r:Repository)
        `;
        const params: Record<string, unknown> = { depth: depth ?? 3 };
        if (repo) {
          cypher += ` WHERE r.path = $repo OR r.name = $repo`;
          params.repo = repo;
        }
        cypher += `
          MATCH (r)-[:CONTAINS_FILE]->(f:File)
          WITH r, f
          OPTIONAL MATCH (f)-[:CONTAINS]->(fn:Function)
          OPTIONAL MATCH (f)-[:CONTAINS]->(c:Class)
          RETURN r.name AS repo, r.path AS repoPath,
                 f.relativePath AS filePath, f.language AS language,
                 count(DISTINCT fn) AS functionCount,
                 count(DISTINCT c) AS classCount
          ORDER BY filePath
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
