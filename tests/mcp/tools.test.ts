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
});
