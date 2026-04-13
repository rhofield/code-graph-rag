// tests/integration/microservices.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { createConnection } from "../../src/db/connection.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository, createProtoRegistry } from "../../src/indexer/index.js";
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

describe.skipIf(!INTEGRATION)("gRPC monorepo integration", () => {
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

  it("creates RPC_CALLS edges in a single indexRepository call", async () => {
    const monoRoot = resolve("tests/fixtures/grpc/monorepo");
    const result = await indexRepository(db, monoRoot, DEFAULT_CONFIG.index);

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'monorepo'
        RETURN caller.name AS callerName, handler.name AS handlerName,
               r.serviceName AS serviceName, r.methodName AS methodName
      `);
      const edges = res.records.map((r) => ({
        callerName: r.get("callerName"),
        handlerName: r.get("handlerName"),
        serviceName: r.get("serviceName"),
        methodName: r.get("methodName"),
      }));

      const getUserEdge = edges.find((e) => e.callerName === "fetchUser" && e.handlerName === "GetUser");
      expect(getUserEdge).toBeDefined();
      expect(getUserEdge!.serviceName).toBe("UserService");
    } finally {
      await session.close();
    }
  });

  it("does not create RPC_CALLS for non-gRPC functions with matching names", async () => {
    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (fn:Function {name: "GetUser"})
        WHERE fn.filePath CONTAINS "not-grpc"
        OPTIONAL MATCH (fn)-[r:RPC_CALLS]-()
        RETURN count(r) AS rpcEdges
      `);
      expect(res.records[0].get("rpcEdges").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
