// tests/integration/microservices.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { resolve, join } from "node:path";
import fs from "node:fs/promises";
import { mkdirSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "../../src/db/connection.js";
import { createTestConnection } from "../helpers/test-db.js";
import { setupSchema } from "../../src/db/schema.js";
import { functionCallersQuery } from "../../src/db/queries.js";
import { indexRepository, createProtoRegistry } from "../../src/indexer/index.js";
import { indexWorkspace } from "../../src/indexer/workspace.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.js";
import { resolveRepos } from "../../src/indexer/resolve-repos.js";
import { removeRepoFromGraph } from "../../src/indexer/graph-cleanup.js";

const INTEGRATION = !!process.env.INTEGRATION;

async function writeApolloGrpcWorkspace(root: string, options: {
  operationField?: string;
  resolverField?: string | null;
  componentUsesQuery?: boolean;
  serviceName?: string;
  methodName?: string;
  handlerMethodName?: string;
} = {}): Promise<void> {
  const operationField = options.operationField ?? "user";
  const resolverField = options.resolverField === undefined ? "user" : options.resolverField;
  const componentUsesQuery = options.componentUsesQuery ?? true;
  const serviceName = options.serviceName ?? "UserService";
  const methodName = options.methodName ?? "GetUser";
  const handlerMethodName = options.handlerMethodName ?? "getUser";
  const clientMethodName = methodName[0].toLowerCase() + methodName.slice(1);

  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(join(root, "frontend/src"), { recursive: true });
  await fs.mkdir(join(root, "api/src"), { recursive: true });
  await fs.mkdir(join(root, "proto"), { recursive: true });
  await fs.mkdir(join(root, "user-service/src"), { recursive: true });

  await fs.writeFile(
    join(root, "frontend/src/queries.ts"),
    `import { gql } from "@apollo/client";

export const GET_APOLLO_USER = gql\`
  query GetApolloUser($id: ID!) {
    ${operationField}(id: $id) {
      id
      name
    }
  }
\`;
`
  );

  await fs.writeFile(
    join(root, "frontend/src/UserProfile.tsx"),
    componentUsesQuery
      ? `import { useQuery } from "@apollo/client";
import { GET_APOLLO_USER } from "./queries";

export function UserProfile({ id }: { id: string }) {
  const { data } = useQuery(GET_APOLLO_USER, { variables: { id } });
  return <div>{data?.${operationField}?.name}</div>;
}
`
      : `export function UserProfile({ id }: { id: string }) {
  return <div>{id}</div>;
}
`
  );

  await fs.writeFile(
    join(root, "api/src/resolvers.ts"),
    resolverField
      ? `import { createPromiseClient } from "@connectrpc/connect";
import { ${serviceName} } from "@buf/example_user.connect";

const userClient = createPromiseClient(${serviceName}, {} as never);

export const resolvers = {
  Query: {
    ${resolverField}: async (_parent: unknown, args: { id: string }) => {
      return userClient.${clientMethodName}({ id: args.id });
    },
  },
};
`
      : `export const resolvers = {
  Query: {},
};
`
  );

  await fs.writeFile(
    join(root, "proto/user.proto"),
    `syntax = "proto3";
package user.v1;
service ${serviceName} {
  rpc ${methodName} (${methodName}Request) returns (${methodName}Response);
}
message ${methodName}Request { string id = 1; }
message ${methodName}Response { string id = 1; string name = 2; }
`
  );

  await fs.writeFile(
    join(root, "user-service/src/handler.ts"),
    `import type { ${methodName}Request } from "@buf/example_user_pb";
import type { ${serviceName}Server } from "@buf/example_user.connect";

export class UserHandler implements ${serviceName}Server {
  async ${handlerMethodName}(request: ${methodName}Request) {
    return { id: request.id, name: "Ada" };
  }
}
`
  );
}

async function cleanupGraphRoot(db: ReturnType<typeof createConnection>, root: string): Promise<void> {
  const session = db.session();
  try {
    await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root });
    await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root });
    await session.run("MATCH (m:ProtoMethod) WHERE m.protoFile STARTS WITH $root DETACH DELETE m", { root });
    await session.run("MATCH (m:ProtoMessage) WHERE m.protoFile STARTS WITH $root DETACH DELETE m", { root });
  } finally {
    await session.close();
  }
}

async function expectApolloGrpcChain(
  db: ReturnType<typeof createConnection>,
  root: string,
  handlerMethodName = "getUser"
): Promise<void> {
  const handlerPath = join(root, "user-service/src/handler.ts");
  const session = db.session();
  try {
    const chain = await session.run(
      `
      MATCH (frontend:Function {name: "UserProfile"})-[:USES_GRAPHQL]->(doc:GraphQLDocument)
            -[:USES_GRAPHQL_RESOLVER]->(resolver:Function {name: "user"})
            -[:RPC_CALLS]->(handler:Function {name: $handlerMethodName, filePath: $handlerPath})
      RETURN frontend.name AS frontendName,
             doc.name AS documentName,
             resolver.name AS resolverName,
             handler.name AS handlerName
      `,
      { handlerPath, handlerMethodName }
    );
    expect(chain.records).toHaveLength(1);
    expect(chain.records[0].get("frontendName")).toBe("UserProfile");
    expect(chain.records[0].get("documentName")).toBe("GetApolloUser");
    expect(chain.records[0].get("resolverName")).toBe("user");
    expect(chain.records[0].get("handlerName")).toBe(handlerMethodName);
  } finally {
    await session.close();
  }
}

describe.skipIf(!INTEGRATION)("microservice integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createTestConnection();
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
    db = createTestConnection();
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

  it("does not wipe ProtoMethod nodes when a repo has a malformed or service-less .proto", async () => {
    const tmpRoot = resolve("tests/fixtures/grpc/_tmp-empty-proto");
    await fs.mkdir(tmpRoot, { recursive: true });
    // .proto with no service block — parser finds zero methods
    await fs.writeFile(resolve(tmpRoot, "empty.proto"), `
      syntax = "proto3";
      package empty;
      message Foo { string bar = 1; }
    `);

    // Seed an unrelated ProtoMethod that should survive
    const seedSession = db.session();
    try {
      await seedSession.run(`
        MERGE (m:ProtoMethod {serviceName: "SurvivorService", methodName: "SurvivorMethod"})
        SET m.protoFile = "/some/other/repo/survivor.proto"
      `);
    } finally {
      await seedSession.close();
    }

    await indexRepository(db, tmpRoot, DEFAULT_CONFIG.index);

    const session = db.session();
    try {
      const r = await session.run(
        `MATCH (m:ProtoMethod {serviceName: "SurvivorService", methodName: "SurvivorMethod"}) RETURN count(m) AS c`
      );
      expect(r.records[0].get("c").toNumber()).toBe(1);
    } finally {
      // Cleanup seeded node — must run even if the assertion throws
      await session.run(`MATCH (m:ProtoMethod {serviceName: "SurvivorService"}) DETACH DELETE m`);
      await session.close();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!INTEGRATION)("gRPC multirepo integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createTestConnection();
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

  it("picks up cross-repo RPC edges even when caller repo is indexed before proto repo", async () => {
    const base = resolve("tests/fixtures/grpc/multirepo");
    const callerRepo = resolve(base, "service-a");
    const protoRepo = resolve(base, "proto-repo");
    const handlerRepo = resolve(base, "service-b");

    // Clean slate: this describe block does not have a per-test beforeEach,
    // and prior tests in the block leave multirepo nodes (and ProtoMethods)
    // in the shared DB. Mirror the cleanup used by the graph-hydration test.
    const cleanupSession = db.session();
    try {
      await cleanupSession.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
      await cleanupSession.run("MATCH (m:ProtoMethod) DETACH DELETE m");
    } finally {
      await cleanupSession.close();
    }

    // Index caller first → no registry entries, no annotations, no edges yet.
    await indexRepository(db, callerRepo, DEFAULT_CONFIG.index);

    let session = db.session();
    try {
      // Scoped to the caller repo: other tests in this file may leave
      // RPC_CALLS edges outside the multirepo fixtures (and our own
      // cleanup intentionally leaves those alone).
      const r1 = await session.run(
        `MATCH (c:Function)-[e:RPC_CALLS]->()
         WHERE c.filePath STARTS WITH $callerRepo
         RETURN count(e) AS c`,
        { callerRepo }
      );
      expect(r1.records[0].get("c").toNumber()).toBe(0);
    } finally { await session.close(); }

    // Then proto repo + handler repo.
    await indexRepository(db, protoRepo, DEFAULT_CONFIG.index);
    await indexRepository(db, handlerRepo, DEFAULT_CONFIG.index);

    // Re-index caller; hydration now sees protos from graph.
    await indexRepository(db, callerRepo, DEFAULT_CONFIG.index);

    session = db.session();
    try {
      const r2 = await session.run(`
        MATCH (c:Function)-[:RPC_CALLS]->(h:Function)
        WHERE c.filePath STARTS WITH $callerRepo
        RETURN count(*) AS c
      `, { callerRepo });
      expect(r2.records[0].get("c").toNumber()).toBeGreaterThan(0);
    } finally { await session.close(); }
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

describe.skipIf(!INTEGRATION)("Apollo GraphQL to gRPC integration", () => {
  let db: ReturnType<typeof createConnection>;
  let tmpRoot: string;

  beforeAll(async () => {
    db = createTestConnection();
    await setupSchema(db);

    tmpRoot = join(tmpdir(), `apollo-graphql-grpc-${Date.now()}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.mkdir(join(tmpRoot, "frontend/src"), { recursive: true });
    await fs.mkdir(join(tmpRoot, "api/src"), { recursive: true });
    await fs.mkdir(join(tmpRoot, "proto"), { recursive: true });
    await fs.mkdir(join(tmpRoot, "user-service/src"), { recursive: true });

    await fs.writeFile(
      join(tmpRoot, "frontend/src/queries.ts"),
      `import { gql } from "@apollo/client";

export const GET_APOLLO_USER = gql\`
  query GetApolloUser($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
\`;
`
    );

    await fs.writeFile(
      join(tmpRoot, "frontend/src/UserProfile.tsx"),
      `import { useQuery } from "@apollo/client";
import { GET_APOLLO_USER } from "./queries";

export function UserProfile({ id }: { id: string }) {
  const { data } = useQuery(GET_APOLLO_USER, { variables: { id } });
  return <div>{data?.user?.name}</div>;
}
`
    );

    await fs.writeFile(
      join(tmpRoot, "api/src/resolvers.ts"),
      `import { createPromiseClient } from "@connectrpc/connect";
import { UserService } from "@buf/example_user.connect";

const userClient = createPromiseClient(UserService, {} as never);

export const resolvers = {
  Query: {
    user: async (_parent: unknown, args: { id: string }) => {
      return userClient.getUser({ id: args.id });
    },
  },
};
`
    );

    await fs.writeFile(
      join(tmpRoot, "proto/user.proto"),
      `syntax = "proto3";
package user.v1;
service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
}
message GetUserRequest { string id = 1; }
message GetUserResponse { string id = 1; string name = 2; }
`
    );

    await fs.writeFile(
      join(tmpRoot, "user-service/src/handler.ts"),
      `import type { GetUserRequest } from "@buf/example_user_pb";
import type { UserServiceServer } from "@buf/example_user.connect";

export class UserHandler implements UserServiceServer {
  async getUser(request: GetUserRequest) {
    return { id: request.id, name: "Ada" };
  }
}
`
    );
  });

  beforeEach(async () => {
    await cleanupGraphRoot(db, tmpRoot);
    await writeApolloGrpcWorkspace(tmpRoot);
  });

  afterAll(async () => {
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root: tmpRoot });
      await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root: tmpRoot });
      await session.run("MATCH (m:ProtoMethod) WHERE m.protoFile STARTS WITH $root DETACH DELETE m", { root: tmpRoot });
      await session.run("MATCH (m:ProtoMessage) WHERE m.protoFile STARTS WITH $root DETACH DELETE m", { root: tmpRoot });
    } finally {
      await session.close();
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    await db.close();
  });

  it("finds frontend Apollo usage when querying callers of a gRPC microservice handler", async () => {
    const result = await indexWorkspace(
      db,
      tmpRoot,
      [
        { path: "frontend", name: "frontend" },
        { path: "proto", name: "proto" },
        { path: "api", name: "api" },
        { path: "user-service", name: "user-service" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );

    expect(result.errors).toEqual([]);
    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const handlerPath = join(tmpRoot, "user-service/src/handler.ts");
    const session = db.session();
    try {
      const chain = await session.run(
        `
        MATCH (frontend:Function {name: "UserProfile"})-[:USES_GRAPHQL]->(doc:GraphQLDocument)
              -[:USES_GRAPHQL_RESOLVER]->(resolver:Function {name: "user"})
              -[:RPC_CALLS]->(handler:Function {name: "getUser", filePath: $handlerPath})
        RETURN frontend.name AS frontendName,
               doc.name AS documentName,
               resolver.name AS resolverName,
               handler.name AS handlerName
        `,
        { handlerPath }
      );
      expect(chain.records).toHaveLength(1);
      expect(chain.records[0].get("frontendName")).toBe("UserProfile");
      expect(chain.records[0].get("documentName")).toBe("GetApolloUser");
      expect(chain.records[0].get("resolverName")).toBe("user");
      expect(chain.records[0].get("handlerName")).toBe("getUser");

      const q = functionCallersQuery({
        functionName: "getUser",
        filePath: handlerPath,
      });
      const callers = await session.run(q.cypher, q.params);
      const rows = callers.records.map((r) => ({
        callerName: r.get("callerName"),
        callType: r.get("callType"),
        graphqlDocument: r.get("graphqlDocument"),
        graphqlResolver: r.get("graphqlResolver"),
      }));

      expect(rows).toContainEqual(
        expect.objectContaining({
          callerName: "UserProfile",
          callType: "USES_GRAPHQL_RESOLVER",
          graphqlDocument: "GetApolloUser",
          graphqlResolver: "user",
        })
      );
    } finally {
      await session.close();
    }
  });

  it.each([
    ["frontend before backend", ["frontend", "proto", "api", "user-service"]],
    ["backend before frontend", ["proto", "user-service", "api", "frontend"]],
    ["resolver before proto", ["api", "frontend", "proto", "user-service"]],
  ])("resolves the frontend-to-handler chain when indexing order is %s", async (_name, order) => {
    const result = await indexWorkspace(
      db,
      tmpRoot,
      order.map((path) => ({ path, name: path })),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );

    expect(result.errors).toEqual([]);
    await expectApolloGrpcChain(db, tmpRoot);
  });

  it("removes stale GraphQL resolver links when an operation changes fields", async () => {
    await indexWorkspace(
      db,
      tmpRoot,
      [
        { path: "frontend", name: "frontend" },
        { path: "proto", name: "proto" },
        { path: "api", name: "api" },
        { path: "user-service", name: "user-service" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    await expectApolloGrpcChain(db, tmpRoot);

    await writeApolloGrpcWorkspace(tmpRoot, {
      operationField: "viewer",
      resolverField: "viewer",
    });
    await indexRepository(db, join(tmpRoot, "frontend"), { ...DEFAULT_CONFIG.index, include: ["**/*"] });
    await indexRepository(db, join(tmpRoot, "api"), { ...DEFAULT_CONFIG.index, include: ["**/*"] });

    const session = db.session();
    try {
      const oldLink = await session.run(
        `
        MATCH (:GraphQLDocument {name: "GetApolloUser"})-[:USES_GRAPHQL_RESOLVER]->(resolver:Function {name: "user"})
        WHERE resolver.filePath STARTS WITH $root
        RETURN count(*) AS count
        `,
        { root: tmpRoot }
      );
      expect(oldLink.records[0].get("count").toNumber()).toBe(0);

      const newLink = await session.run(
        `
        MATCH (:GraphQLDocument {name: "GetApolloUser"})-[:USES_GRAPHQL_RESOLVER]->(resolver:Function {name: "viewer"})
        WHERE resolver.filePath STARTS WITH $root
        RETURN count(*) AS count
        `,
        { root: tmpRoot }
      );
      expect(newLink.records[0].get("count").toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("removes stale GraphQL resolver links when the resolver is deleted", async () => {
    await indexWorkspace(
      db,
      tmpRoot,
      [
        { path: "frontend", name: "frontend" },
        { path: "proto", name: "proto" },
        { path: "api", name: "api" },
        { path: "user-service", name: "user-service" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    await expectApolloGrpcChain(db, tmpRoot);

    await writeApolloGrpcWorkspace(tmpRoot, { resolverField: null });
    await indexRepository(db, join(tmpRoot, "api"), { ...DEFAULT_CONFIG.index, include: ["**/*"] });

    const session = db.session();
    try {
      const rels = await session.run(
        `
        MATCH (:GraphQLDocument {name: "GetApolloUser"})-[r:USES_GRAPHQL_RESOLVER]->(resolver:Function)
        WHERE resolver.filePath STARTS WITH $root
        RETURN count(r) AS count
        `,
        { root: tmpRoot }
      );
      expect(rels.records[0].get("count").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("removes stale frontend usage links when the component stops using the operation", async () => {
    await indexWorkspace(
      db,
      tmpRoot,
      [
        { path: "frontend", name: "frontend" },
        { path: "proto", name: "proto" },
        { path: "api", name: "api" },
        { path: "user-service", name: "user-service" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    await expectApolloGrpcChain(db, tmpRoot);

    await writeApolloGrpcWorkspace(tmpRoot, { componentUsesQuery: false });
    await indexRepository(db, join(tmpRoot, "frontend"), { ...DEFAULT_CONFIG.index, include: ["**/*"] });

    const session = db.session();
    try {
      const usage = await session.run(
        `
        MATCH (frontend:Function {name: "UserProfile"})-[r:USES_GRAPHQL]->(:GraphQLDocument)
        WHERE frontend.filePath STARTS WITH $root
        RETURN count(r) AS count
        `,
        { root: tmpRoot }
      );
      expect(usage.records[0].get("count").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });

  it.fails("documents current ambiguity when two APIs expose the same Query.user field", async () => {
    const ambiguousRoot = join(tmpdir(), `apollo-ambiguous-${Date.now()}`);
    try {
      await writeApolloGrpcWorkspace(ambiguousRoot);
      await fs.mkdir(join(ambiguousRoot, "profile-proto"), { recursive: true });
      await fs.mkdir(join(ambiguousRoot, "profile-api/src"), { recursive: true });
      await fs.mkdir(join(ambiguousRoot, "profile-service/src"), { recursive: true });

      await fs.writeFile(
        join(ambiguousRoot, "profile-proto/profile.proto"),
        `syntax = "proto3";
package profile.v1;
service ProfileService {
  rpc GetProfile (GetProfileRequest) returns (GetProfileResponse);
}
message GetProfileRequest { string id = 1; }
message GetProfileResponse { string id = 1; string name = 2; }
`
      );
      await fs.writeFile(
        join(ambiguousRoot, "profile-api/src/resolvers.ts"),
        `import { createPromiseClient } from "@connectrpc/connect";
import { ProfileService } from "@buf/example_profile.connect";

const profileClient = createPromiseClient(ProfileService, {} as never);

export const resolvers = {
  Query: {
    user: async (_parent: unknown, args: { id: string }) => {
      return profileClient.getProfile({ id: args.id });
    },
  },
};
`
      );
      await fs.writeFile(
        join(ambiguousRoot, "profile-service/src/handler.ts"),
        `import type { GetProfileRequest } from "@buf/example_profile_pb";
import type { ProfileServiceServer } from "@buf/example_profile.connect";

export class ProfileHandler implements ProfileServiceServer {
  async getProfile(request: GetProfileRequest) {
    return { id: request.id, name: "Grace" };
  }
}
`
      );

      await indexWorkspace(
        db,
        ambiguousRoot,
        [
          { path: "frontend", name: "frontend" },
          { path: "proto", name: "proto" },
          { path: "user-service", name: "user-service" },
          { path: "api", name: "api" },
          { path: "profile-proto", name: "profile-proto" },
          { path: "profile-service", name: "profile-service" },
          { path: "profile-api", name: "profile-api" },
        ],
        { ...DEFAULT_CONFIG.index, include: ["**/*"] }
      );

      const q = functionCallersQuery({
        functionName: "getProfile",
        filePath: join(ambiguousRoot, "profile-service/src/handler.ts"),
      });
      const session = db.session();
      try {
        const callers = await session.run(q.cypher, q.params);
        const frontendRows = callers.records.filter((r) => r.get("callerName") === "UserProfile");
        expect(frontendRows).toHaveLength(0);
      } finally {
        await session.close();
      }
    } finally {
      await cleanupGraphRoot(db, ambiguousRoot);
      rmSync(ambiguousRoot, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!INTEGRATION)("pure-container discovery integration", () => {
  let db: ReturnType<typeof createConnection>;
  let tmpRoot: string;

  beforeAll(async () => {
    db = createTestConnection();
    await setupSchema(db);

    // Build a pure-container: two existing fixture microservices copied into
    // a fresh temp root, with .git dirs added to simulate real repos.
    tmpRoot = join(tmpdir(), `pure-container-${Date.now()}`);
    mkdirSync(tmpRoot, { recursive: true });
    for (const svc of ["auth-service", "user-service"]) {
      const src = resolve("tests/fixtures/microservices", svc);
      const dst = join(tmpRoot, svc);
      cpSync(src, dst, { recursive: true });
      mkdirSync(join(dst, ".git"), { recursive: true });
    }

    // Clean any prior graph nodes that might alias these paths.
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root: tmpRoot });
      await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root: tmpRoot });
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n", { root: tmpRoot });
      await session.run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r", { root: tmpRoot });
    } finally {
      await session.close();
    }
    rmSync(tmpRoot, { recursive: true, force: true });
    await db.close();
  });

  it("discovers subrepos and indexes each as its own Repository node", async () => {
    const config = loadConfig(tmpRoot);
    const resolved = await resolveRepos({
      workspaceRoot: tmpRoot,
      config,
      removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
    });
    expect(resolved.mode).toBe("workspace");
    expect(resolved.repos.map((r) => r.path).sort()).toEqual(["auth-service", "user-service"]);

    const result = await indexWorkspace(db, tmpRoot, resolved.repos, DEFAULT_CONFIG.index);
    expect(result.repos.length).toBe(2);

    const session = db.session();
    try {
      const res = await session.run(
        "MATCH (r:Repository) WHERE r.path STARTS WITH $root RETURN r.path AS path ORDER BY path",
        { root: tmpRoot }
      );
      const paths = res.records.map((r) => r.get("path") as string);
      expect(paths).toEqual([join(tmpRoot, "auth-service"), join(tmpRoot, "user-service")]);
    } finally {
      await session.close();
    }

    // .rho-graph.json was written
    expect(existsSync(join(tmpRoot, ".rho-graph.json"))).toBe(true);
  });

  it("removes the Repository node when a subrepo's .git disappears", async () => {
    // Remove .git from user-service, then re-resolve with force
    rmSync(join(tmpRoot, "user-service", ".git"), { recursive: true, force: true });
    const config = loadConfig(tmpRoot);
    const resolved = await resolveRepos({
      workspaceRoot: tmpRoot,
      config,
      force: true,
      removeRepoFromGraph: (p) => removeRepoFromGraph(db, p),
    });
    expect(resolved.repos.map((r) => r.path)).toEqual(["auth-service"]);
    expect(resolved.removed).toEqual(["user-service"]);

    const session = db.session();
    try {
      const res = await session.run(
        "MATCH (r:Repository) WHERE r.path = $p RETURN count(r) AS c",
        { p: join(tmpRoot, "user-service") }
      );
      expect(res.records[0].get("c").toNumber()).toBe(0);
      const files = await session.run(
        "MATCH (f:File) WHERE f.path STARTS WITH $p RETURN count(f) AS c",
        { p: join(tmpRoot, "user-service") }
      );
      expect(files.records[0].get("c").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
