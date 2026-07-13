// tests/mcp/tools.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerSearchCode } from "../../src/mcp/tools/search-code.js";
import { registerGetCallers } from "../../src/mcp/tools/get-callers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("MCP tools registration", () => {
  it("registerSearchCode registers a tool without throwing", () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: (name: string) => {
        registeredTools.push(name);
      },
    };
    const mockDb = {
      driver: {},
      session: vi.fn(),
      healthCheck: vi.fn(),
      close: vi.fn(),
    };

    expect(() => registerSearchCode(mockServer as any, mockDb as any)).not.toThrow();
    expect(registeredTools).toContain("search_code");
  });

  it("registerGetCallers registers a tool without throwing", () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: (name: string) => {
        registeredTools.push(name);
      },
    };
    const mockDb = {
      driver: {},
      session: vi.fn(),
      healthCheck: vi.fn(),
      close: vi.fn(),
    };

    expect(() => registerGetCallers(mockServer as any, mockDb as any)).not.toThrow();
    expect(registeredTools).toContain("get_callers");
  });

  it("get_callers returns GraphQL frontend caller rows from the database result", async () => {
    let handler: ((args: { functionName: string; filePath?: string }) => Promise<any>) | null = null;
    const mockServer = {
      tool: (_name: string, _description: string, _schema: unknown, cb: typeof handler) => {
        handler = cb;
      },
    };
    const run = vi.fn().mockResolvedValue({
      records: [
        {
          toObject: () => ({
            callerName: "UserProfile",
            callerFilePath: "/repo/frontend/src/UserProfile.tsx",
            callType: "USES_GRAPHQL_RESOLVER",
            graphqlDocument: "GetApolloUser",
            graphqlResolver: "user",
          }),
        },
      ],
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      session: () => ({ run, close }),
    };

    registerGetCallers(mockServer as any, mockDb as any);

    const result = await handler!({
      functionName: "getUser",
      filePath: "/repo/user-service/src/handler.ts",
    });

    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("USES_GRAPHQL_RESOLVER"),
      {
        functionName: "getUser",
        filePath: "/repo/user-service/src/handler.ts",
      }
    );
    expect(JSON.parse(result.content[0].text)).toEqual([
      expect.objectContaining({
        callerName: "UserProfile",
        callType: "USES_GRAPHQL_RESOLVER",
        graphqlDocument: "GetApolloUser",
        graphqlResolver: "user",
      }),
    ]);
    expect(close).toHaveBeenCalled();
  });
});
