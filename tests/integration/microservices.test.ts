// tests/integration/microservices.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { createConnection } from "../../src/db/connection.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository } from "../../src/indexer/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const INTEGRATION = !!process.env.INTEGRATION;

describe.skipIf(!INTEGRATION)("microservice integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("indexes all 3 microservices and creates repository nodes", async () => {
    const services = [
      resolve("tests/fixtures/microservices/auth-service"),
      resolve("tests/fixtures/microservices/api-gateway"),
      resolve("tests/fixtures/microservices/user-service"),
    ];

    for (const service of services) {
      await indexRepository(db, service, DEFAULT_CONFIG.index);
    }

    const session = db.session();
    try {
      const result = await session.run("MATCH (r:Repository) RETURN count(r) AS count");
      const count = result.records[0].get("count").toNumber();
      expect(count).toBeGreaterThanOrEqual(3);
    } finally {
      await session.close();
    }
  });

  it("extracts functions from auth-service", async () => {
    const session = db.session();
    try {
      const result = await session.run(
        "MATCH (fn:Function) WHERE fn.filePath CONTAINS 'auth-service' RETURN fn.name AS name"
      );
      const names = result.records.map((r) => r.get("name"));
      expect(names).toContain("validateToken");
      expect(names).toContain("generateToken");
    } finally {
      await session.close();
    }
  });

  it("extracts classes from user-service", async () => {
    const session = db.session();
    try {
      const result = await session.run(
        "MATCH (c:Class) WHERE c.filePath CONTAINS 'user-service' RETURN c.name AS name"
      );
      const names = result.records.map((r) => r.get("name"));
      expect(names).toContain("UserController");
      expect(names).toContain("ProfileService");
    } finally {
      await session.close();
    }
  });
});
