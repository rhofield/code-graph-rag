// tests/integration/pubsub-realistic.test.ts
//
// Production-faithful replica of the architecture the toy pubsub fixture
// idealizes away. Differences that matter, all present here:
//
//   - Real generated code is indexed: protoc-gen-go output (events.pb.go),
//     protoc-gen-go-grpc output (users_grpc.pb.go), protoc-gen-es output
//     (events_pb.ts).
//   - Protos use buf-style go_package paths under gen/ — no "proto", "pb",
//     or "grpc" token in the Go import path.
//   - The proto set includes a service block, so a _grpc.pb.go dispatcher
//     exists and shows up as the in-repo "caller" of the real handler.
//   - The Go business code builds the event message but delegates
//     proto.Marshal to a generic publisher wrapper.
//   - One Pub/Sub handler is a named function, the other an inline anonymous
//     callback inside a named setup function.
//
// Detection probes run without a DB; the full-chain section needs Neo4j and
// is gated behind INTEGRATION.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { createConnection } from "../../src/db/connection.js";
import { createTestConnection } from "../helpers/test-db.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexWorkspace } from "../../src/indexer/workspace.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { initParser, parseFile } from "../../src/indexer/parser.js";
import { createProtoRegistry } from "../../src/indexer/proto-registry.js";
import { parseProtoFile } from "../../src/indexer/proto-parser.js";
import { detectMessagePatterns } from "../../src/indexer/message-detector.js";
import { detectRpcPatterns } from "../../src/indexer/rpc-detector.js";
import type { ProtoRegistry } from "../../src/indexer/proto-registry.js";

const INTEGRATION = !!process.env.INTEGRATION;
const ROOT = resolve("tests/fixtures/pubsub-realistic/workspace");

const SEMANTIC_RELS =
  "CALLS|RPC_CALLS|USES_PROTO|USES_GRAPHQL|USES_GRAPHQL_RESOLVER|PUBLISHES_TO|SUBSCRIBES_TO";

describe("Realistic Pub/Sub detection probes (no DB)", () => {
  let registry: ProtoRegistry;

  async function detectMessages(relPath: string) {
    const filePath = join(ROOT, relPath);
    const parsed = await parseFile(filePath);
    expect(parsed).not.toBeNull();
    const annotations = detectMessagePatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, registry);
    parsed!.tree.delete();
    return annotations;
  }

  async function detectRpc(relPath: string) {
    const filePath = join(ROOT, relPath);
    const parsed = await parseFile(filePath);
    expect(parsed).not.toBeNull();
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, registry);
    parsed!.tree.delete();
    return annotations;
  }

  beforeAll(async () => {
    await initParser();
    registry = createProtoRegistry();
    parseProtoFile(join(ROOT, "proto/events.proto"), registry);
    parseProtoFile(join(ROOT, "proto/users.proto"), registry);
  });

  it("registers event messages and the user service from the protos", () => {
    expect(registry.lookupMessage("UserCreated")).toHaveLength(1);
    expect(registry.lookupMessage("OrderShipped")).toHaveLength(1);
    expect(registry.getAllServices()).toContain("UserService");
  });

  it("annotates the Go business function that builds UserCreated (marshal lives in a wrapper)", async () => {
    const annotations = await detectMessages("backend-go/server.go");
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "CreateUser", messageName: "UserCreated" })
    );
  });

  it("annotates the Go business function that builds OrderShipped", async () => {
    const annotations = await detectMessages("backend-go/server.go");
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "ShipOrder", messageName: "OrderShipped" })
    );
  });

  it("annotates the real Go GetUser impl as the RPC handler", async () => {
    const annotations = await detectRpc("backend-go/server.go");
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "GetUser", role: "handler", serviceName: "UserService" })
    );
  });

  it("annotates the named TS subscriber handler as a consumer of UserCreated", async () => {
    const annotations = await detectMessages("graph-layer/src/subscriber.ts");
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "handleUserCreated", role: "consumer", messageName: "UserCreated" })
    );
  });

  it("annotates the setup function containing the inline anonymous handler as a consumer of OrderShipped", async () => {
    const annotations = await detectMessages("graph-layer/src/subscriber.ts");
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "startSubscribers", role: "consumer", messageName: "OrderShipped" })
    );
  });

  it("does not annotate generated protoc-gen-es classes as producers or consumers", async () => {
    const annotations = await detectMessages("graph-layer/src/gen/events_pb.ts");
    expect(annotations.filter((a) => a.role !== "uses")).toEqual([]);
  });
});

describe.skipIf(!INTEGRATION)("Realistic Pub/Sub event flow graph (full chain)", () => {
  let db: ReturnType<typeof createConnection>;

  async function run(cypher: string, params: Record<string, unknown> = {}) {
    const session = db.session();
    try {
      return await session.run(cypher, { root: ROOT, ...params });
    } finally {
      await session.close();
    }
  }

  async function cleanup() {
    await run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n");
    await run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r");
    await run("MATCH (m:ProtoMethod) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");
    await run("MATCH (m:ProtoMessage) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");
  }

  beforeAll(async () => {
    db = createTestConnection();
    await setupSchema(db);
    await cleanup();

    const result = await indexWorkspace(
      db,
      ROOT,
      [
        { path: "proto", name: "proto" },
        { path: "backend-go", name: "backend-go" },
        { path: "graph-layer", name: "graph-layer" },
        { path: "frontend", name: "frontend" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    expect(result.errors).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await db.close();
  });

  it("hop 1: frontend component USES_GRAPHQL the GetRealisticUser document", async () => {
    const res = await run(`
      MATCH (fn:Function {name: "UserDashboard"})-[:USES_GRAPHQL]->(doc:GraphQLDocument)
      WHERE fn.filePath STARTS WITH $root
      RETURN doc.name AS docName
    `);
    expect(res.records.map((r) => r.get("docName"))).toContain("GetRealisticUser");
  });

  it("hop 2: document USES_GRAPHQL_RESOLVER the realisticUser resolver", async () => {
    const res = await run(`
      MATCH (doc:GraphQLDocument {name: "GetRealisticUser"})-[:USES_GRAPHQL_RESOLVER]->(resolver:Function)
      WHERE resolver.filePath STARTS WITH $root
      RETURN resolver.name AS resolverName
    `);
    expect(res.records.map((r) => r.get("resolverName"))).toContain("realisticUser");
  });

  it("hop 3: resolver CALLS into the graph-layer store", async () => {
    const res = await run(`
      MATCH (resolver:Function {name: "realisticUser"})-[:CALLS]->(callee:Function {name: "getCachedUser"})
      WHERE resolver.filePath STARTS WITH $root
      RETURN count(*) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("hop 4: subscriber handler CALLS into the graph-layer store", async () => {
    const res = await run(`
      MATCH (sub:Function {name: "handleUserCreated"})-[:CALLS]->(callee:Function {name: "saveCachedUser"})
      WHERE sub.filePath STARTS WITH $root
      RETURN count(*) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("hop 5: TS subscriber handler has a semantic link to the UserCreated event", async () => {
    const res = await run(`
      MATCH (sub:Function {name: "handleUserCreated"})
      WHERE sub.filePath STARTS WITH $root
      MATCH (sub)-[r:USES_PROTO|PUBLISHES_TO|SUBSCRIBES_TO]-(evt)
      RETURN count(r) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("hop 6: Go business publisher (CreateUser) has a semantic link to the UserCreated event", async () => {
    const res = await run(`
      MATCH (pub:Function {name: "CreateUser"})
      WHERE pub.filePath STARTS WITH $root
      MATCH (pub)-[r:USES_PROTO|PUBLISHES_TO|SUBSCRIBES_TO]-(evt)
      RETURN count(r) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("grpc: the real Go GetUser impl is the RPC handler, reachable from the generated dispatcher", async () => {
    const res = await run(`
      MATCH (impl:Function {name: "GetUser", rpcHandlerService: "UserService"})
      WHERE impl.filePath STARTS WITH $root AND NOT impl.filePath CONTAINS "_grpc.pb.go"
      RETURN impl.filePath AS path
    `);
    expect(res.records.length).toBeGreaterThan(0);
  });

  it("end-to-end: Go business publisher is reachable from the frontend component", async () => {
    const res = await run(`
      MATCH (frontend:Function {name: "UserDashboard"}), (pub:Function {name: "CreateUser"})
      WHERE frontend.filePath STARTS WITH $root AND pub.filePath STARTS WITH $root
      MATCH p = shortestPath((frontend)-[:${SEMANTIC_RELS}*..8]-(pub))
      RETURN length(p) AS hops
    `);
    expect(res.records.length).toBeGreaterThan(0);
  });
});
