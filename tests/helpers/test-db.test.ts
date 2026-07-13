import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("TEST_NEO4J_CONFIG", () => {
  it("falls back to standard NEO4J_* env vars used by CI", async () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.NEO4J_USERNAME = "neo4j";
    process.env.NEO4J_PASSWORD = "code-graph-rag";
    delete process.env.NEO4J_TEST_URI;
    delete process.env.NEO4J_TEST_USERNAME;
    delete process.env.NEO4J_TEST_PASSWORD;

    const { TEST_NEO4J_CONFIG } = await import("../../tests/helpers/test-db.js");

    expect(TEST_NEO4J_CONFIG).toEqual({
      uri: "bolt://localhost:7687",
      username: "neo4j",
      password: "code-graph-rag",
    });
  });
});
