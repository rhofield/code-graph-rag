// tests/integration/microservices.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import fs from "node:fs/promises";
import { createConnection } from "../../src/db/connection.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository, createProtoRegistry } from "../../src/indexer/index.js";
import { indexWorkspace } from "../../src/indexer/workspace.js";
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

  it("removes stale RPC_CALLS edges when caller switches RPCs on re-index", async () => {
    const tmpRoot = resolve("tests/fixtures/grpc/_tmp-stale-edge");
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(
      resolve(tmpRoot, "user.proto"),
      `syntax = "proto3";
package user.v1;
service UserService {
  rpc GetUser (Req) returns (Resp);
  rpc CreateUser (Req) returns (Resp);
}
message Req {}
message Resp {}
`
    );
    await fs.writeFile(
      resolve(tmpRoot, "handler.go"),
      `package main

import (
\t"context"
\tpb "myproject/proto/user/v1"
)

type UserServiceServer struct {
\tpb.UnimplementedUserServiceServer
}

func (s *UserServiceServer) GetUser(ctx context.Context, req *pb.Req) (*pb.Resp, error) {
\treturn &pb.Resp{}, nil
}

func (s *UserServiceServer) CreateUser(ctx context.Context, req *pb.Req) (*pb.Resp, error) {
\treturn &pb.Resp{}, nil
}
`
    );
    const callerPath = resolve(tmpRoot, "caller.go");
    await fs.writeFile(
      callerPath,
      `package main

import (
\t"context"
\tpb "myproject/proto/user/v1"
)

func invoke(ctx context.Context, c pb.UserServiceClient) {
\tc.GetUser(ctx, &pb.Req{})
}
`
    );
    try {
      await indexRepository(db, tmpRoot, DEFAULT_CONFIG.index);

      await fs.writeFile(
        callerPath,
        `package main

import (
\t"context"
\tpb "myproject/proto/user/v1"
)

func invoke(ctx context.Context, c pb.UserServiceClient) {
\tc.CreateUser(ctx, &pb.Req{})
}
`
      );
      await indexRepository(db, tmpRoot, DEFAULT_CONFIG.index);

      const session = db.session();
      try {
        const r = await session.run(
          `
          MATCH (caller:Function {name: "invoke"})-[e:RPC_CALLS]->(handler:Function)
          WHERE caller.filePath CONTAINS '_tmp-stale-edge'
            AND handler.filePath CONTAINS '_tmp-stale-edge'
          RETURN collect(e.methodName) AS methods
        `
        );
        const methods = r.records[0]?.get("methods") ?? [];
        expect(methods).toEqual(["CreateUser"]);
      } finally {
        await session.close();
      }
    } finally {
      const session = db.session();
      try {
        await session.run(
          "MATCH (n) WHERE n.filePath CONTAINS '_tmp-stale-edge' DETACH DELETE n"
        );
      } finally {
        await session.close();
      }
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // Note: this test's full-index prune deletes ProtoMethod nodes from other
  // services in the shared DB. Kept last in this describe block; subsequent
  // describe blocks re-index their fixtures and repopulate their own defs.
  it("removes orphan ProtoMethod nodes when methods are deleted from .proto", async () => {
    const tmpRoot = resolve("tests/fixtures/grpc/_tmp-orphan");
    const protoPath = resolve(tmpRoot, "svc.proto");
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(protoPath, `
      syntax = "proto3";
      package t;
      service T {
        rpc A (Req) returns (Resp);
        rpc B (Req) returns (Resp);
      }
    `);
    await indexRepository(db, tmpRoot, DEFAULT_CONFIG.index);

    // Remove method B
    await fs.writeFile(protoPath, `
      syntax = "proto3";
      package t;
      service T { rpc A (Req) returns (Resp); }
    `);
    await indexRepository(db, tmpRoot, DEFAULT_CONFIG.index);

    const session = db.session();
    try {
      const r = await session.run(
        `MATCH (m:ProtoMethod {serviceName: "T"}) RETURN collect(m.methodName) AS names`
      );
      const names = r.records[0].get("names");
      expect(names).toContain("A");
      expect(names).not.toContain("B");
    } finally {
      await session.close();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!INTEGRATION)("gRPC multirepo integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it("resolves cross-repo RPC_CALLS with shared ProtoRegistry", async () => {
    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    const result = await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-b"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN caller.name AS callerName, handler.name AS handlerName,
               r.serviceName AS serviceName, r.methodName AS methodName
      `);
      expect(res.records.length).toBeGreaterThan(0);
      expect(res.records[0].get("callerName")).toBe("loadUser");
      expect(res.records[0].get("handlerName")).toBe("getUser");
      expect(res.records[0].get("serviceName")).toBe("UserService");
    } finally {
      await session.close();
    }
  });

  it("resolves edges regardless of service indexing order", async () => {
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
    } finally {
      await session.close();
    }

    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    // Index handler FIRST, then caller
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-b"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    const result = await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session2 = db.session();
    try {
      const res = await session2.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session2.close();
    }
  });

  it("resolves cross-repo edges via graph hydration when no shared registry is passed", async () => {
    // Simulates the CLI pathway: each invocation runs with a fresh registry.
    // Proto definitions persisted by the first run must be picked up by later
    // runs through the ProtoMethod hydration step, otherwise rpcDetectFn is
    // undefined and no annotations are ever recorded.
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
      await session.run("MATCH (m:ProtoMethod) DETACH DELETE m");
    } finally {
      await session.close();
    }

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-b"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    const result = await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session2 = db.session();
    try {
      const res = await session2.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session2.close();
    }
  });

  it("indexWorkspace resolves cross-repo edges with config.repos-style paths", async () => {
    const session0 = db.session();
    try {
      await session0.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
      await session0.run("MATCH (m:ProtoMethod) DETACH DELETE m");
    } finally {
      await session0.close();
    }

    const workspaceRoot = resolve("tests/fixtures/grpc/multirepo");
    const result = await indexWorkspace(
      db,
      workspaceRoot,
      [
        { path: "proto-repo", name: "proto" },
        { path: "service-b", name: "service-b" },
        { path: "service-a", name: "service-a" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);
    expect(result.repos.length).toBe(3);

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("preserves cross-repo edges when re-indexing a single service", async () => {
    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
