import { describe, expect, it, vi } from "vitest";
import { linkGraphQLResolverEdges } from "../../src/indexer/graphql-linker.js";

describe("linkGraphQLResolverEdges", () => {
  it("clears stale resolver links before recreating graph-wide links", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ get: () => ({ toNumber: () => 3 }) }] });
    const close = vi.fn().mockResolvedValue(undefined);
    const db = {
      session: () => ({ run, close }),
    };

    const created = await linkGraphQLResolverEdges(db as never);

    expect(created).toBe(3);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toContain("DELETE r");
    expect(run.mock.calls[1][0]).toContain("MERGE (doc)-[r:USES_GRAPHQL_RESOLVER]->(resolver)");
  });
});
