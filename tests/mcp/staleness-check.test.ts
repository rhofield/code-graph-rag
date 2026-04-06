// tests/mcp/staleness-check.test.ts
import { describe, it, expect, vi } from "vitest";
import { checkStaleness } from "../../src/mcp/staleness-check.js";

describe("checkStaleness", () => {
  it("returns fresh when no files are stale", async () => {
    const mockSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: (key: string) => {
              const data: Record<string, unknown> = {
                path: "/project/src/index.ts",
                hash: "abc123",
                lastModified: Date.now(),
              };
              return data[key];
            },
          },
        ],
      }),
      close: vi.fn(),
    };

    const result = await checkStaleness(
      { session: () => mockSession } as any,
      ["/project/src/index.ts"],
      () => false
    );

    expect(result.staleFiles).toHaveLength(0);
    expect(result.needsWarning).toBe(false);
  });

  it("returns warning when more than 20 files are stale", async () => {
    const stalePaths = Array.from(
      { length: 25 },
      (_, i) => `/project/src/file${i}.ts`
    );
    const records = stalePaths.map((path) => ({
      get: (key: string) => {
        const data: Record<string, unknown> = {
          path,
          hash: "old",
          lastModified: 0,
        };
        return data[key];
      },
    }));

    const mockSession = {
      run: vi.fn().mockResolvedValue({ records }),
      close: vi.fn(),
    };

    const result = await checkStaleness(
      { session: () => mockSession } as any,
      stalePaths,
      () => true
    );

    expect(result.staleFiles.length).toBe(25);
    expect(result.needsWarning).toBe(true);
  });
});
