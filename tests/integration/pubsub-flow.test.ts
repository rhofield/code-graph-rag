// tests/integration/pubsub-flow.test.ts
//
// Replica of the production architecture that the graph currently fails to
// connect end-to-end:
//
//   backend-go / backend-ts ──(protobuf message over Google Pub/Sub)──▶
//   graph-layer subscriber ──▶ store ──▶ Apollo resolver ──(GraphQL)──▶
//   frontend useQuery component
//
// Each hop is asserted separately so a failure pinpoints the exact broken
// linkage rather than just "chain missing".
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
import type { ProtoRegistry } from "../../src/indexer/proto-registry.js";

const INTEGRATION = !!process.env.INTEGRATION;
const ROOT = resolve("tests/fixtures/pubsub/workspace");

// Every semantic (non-structural) relationship type the graph can produce.
// Path assertions use these so File/Repository containment edges can't
// fabricate connectivity. PUBLISHES_TO/SUBSCRIBES_TO don't exist yet; they
// are listed so the assertions keep working once a messaging model lands.
const SEMANTIC_RELS =
  "CALLS|RPC_CALLS|USES_PROTO|USES_GRAPHQL|USES_GRAPHQL_RESOLVER|PUBLISHES_TO|SUBSCRIBES_TO";

describe.skipIf(!INTEGRATION)("Pub/Sub detection probes (no DB)", () => {
  let registry: ProtoRegistry;

  beforeAll(async () => {
    await initParser();
    registry = createProtoRegistry();
    parseProtoFile(join(ROOT, "proto/events.proto"), registry);
  });

  it("registers the UserCreated message from the message-only proto", () => {
    // events.proto has no `service` block — only the UserCreated message.
    // RPC detection still has nothing to key on, but message registration
    // gives pub/sub flows a node for publisher and subscriber to meet at.
    expect(registry.getAllServices()).toEqual([]);
    expect(registry.lookupMessage("UserCreated")).toHaveLength(1);
  });

  it("annotates the TS subscriber as a consumer of UserCreated", async () => {
    const filePath = join(ROOT, "graph-layer/src/subscriber.ts");
    const parsed = await parseFile(filePath);
    expect(parsed).not.toBeNull();
    const annotations = detectMessagePatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, registry);
    parsed!.tree.delete();
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "handleUserCreated", role: "consumer", messageName: "UserCreated" })
    );
  });

  it("annotates the Go publisher as a producer of UserCreated", async () => {
    const filePath = join(ROOT, "backend-go/publisher.go");
    const parsed = await parseFile(filePath);
    expect(parsed).not.toBeNull();
    const annotations = detectMessagePatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, registry);
    parsed!.tree.delete();
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "PublishUserCreated", role: "producer", messageName: "UserCreated" })
    );
  });

  it("annotates the TS publisher as a producer of UserCreated", async () => {
    const filePath = join(ROOT, "backend-ts/src/publisher.ts");
    const parsed = await parseFile(filePath);
    expect(parsed).not.toBeNull();
    const annotations = detectMessagePatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, registry);
    parsed!.tree.delete();
    expect(annotations).toContainEqual(
      expect.objectContaining({ functionName: "publishUserCreated", role: "producer", messageName: "UserCreated" })
    );
  });
});

describe.skipIf(!INTEGRATION)("Pub/Sub event flow graph (full chain)", () => {
  let db: ReturnType<typeof createConnection>;

  async function run(cypher: string, params: Record<string, unknown> = {}) {
    const session = db.session();
    try {
      return await session.run(cypher, { root: ROOT, ...params });
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    db = createTestConnection();
    await setupSchema(db);

    await run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n");
    await run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r");
    await run("MATCH (m:ProtoMethod) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");
    await run("MATCH (m:ProtoMessage) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");

    const result = await indexWorkspace(
      db,
      ROOT,
      [
        { path: "proto", name: "proto" },
        { path: "backend-go", name: "backend-go" },
        { path: "backend-ts", name: "backend-ts" },
        { path: "graph-layer", name: "graph-layer" },
        { path: "frontend", name: "frontend" },
      ],
      { ...DEFAULT_CONFIG.index, include: ["**/*"] }
    );
    expect(result.errors).toEqual([]);
  }, 120_000);

  afterAll(async () => {
    await run("MATCH (n) WHERE n.filePath STARTS WITH $root DETACH DELETE n");
    await run("MATCH (r:Repository) WHERE r.path STARTS WITH $root DETACH DELETE r");
    await run("MATCH (m:ProtoMethod) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");
    await run("MATCH (m:ProtoMessage) WHERE m.protoFile STARTS WITH $root DETACH DELETE m");
    await db.close();
  });

  it("sanity: all key functions were indexed", async () => {
    const res = await run(`
      MATCH (fn:Function)
      WHERE fn.filePath STARTS WITH $root
      RETURN collect(fn.name) AS names
    `);
    const names = res.records[0].get("names") as string[];
    for (const expected of [
      "PublishUserCreated",   // backend-go
      "publishUserCreated",   // backend-ts
      "handleUserCreated",    // graph-layer subscriber
      "saveCachedUser",
      "getCachedUser",
      "pubsubUser",           // resolver
      "UserDashboard",        // frontend component
    ]) {
      expect(names, `missing Function node: ${expected}`).toContain(expected);
    }
  });

  it("hop 1: frontend component USES_GRAPHQL the GetPubsubUser document", async () => {
    const res = await run(`
      MATCH (fn:Function {name: "UserDashboard"})-[:USES_GRAPHQL]->(doc:GraphQLDocument)
      WHERE fn.filePath STARTS WITH $root
      RETURN doc.name AS docName
    `);
    expect(res.records.map((r) => r.get("docName"))).toContain("GetPubsubUser");
  });

  it("hop 2: document USES_GRAPHQL_RESOLVER the pubsubUser resolver", async () => {
    const res = await run(`
      MATCH (doc:GraphQLDocument {name: "GetPubsubUser"})-[:USES_GRAPHQL_RESOLVER]->(resolver:Function)
      WHERE resolver.filePath STARTS WITH $root
      RETURN resolver.name AS resolverName
    `);
    expect(res.records.map((r) => r.get("resolverName"))).toContain("pubsubUser");
  });

  it("hop 3: resolver CALLS into the graph-layer store", async () => {
    const res = await run(`
      MATCH (resolver:Function {name: "pubsubUser"})-[:CALLS]->(callee:Function {name: "getCachedUser"})
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

  it("hop 5 (messaging, desired): subscriber handler has a semantic link to the event", async () => {
    const res = await run(`
      MATCH (sub:Function {name: "handleUserCreated"})
      WHERE sub.filePath STARTS WITH $root
      MATCH (sub)-[r:USES_PROTO|PUBLISHES_TO|SUBSCRIBES_TO]-(evt)
      RETURN count(r) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("hop 6 (messaging, desired): Go publisher has a semantic link to the event", async () => {
    const res = await run(`
      MATCH (pub:Function {name: "PublishUserCreated"})
      WHERE pub.filePath STARTS WITH $root
      MATCH (pub)-[r:USES_PROTO|PUBLISHES_TO|SUBSCRIBES_TO]-(evt)
      RETURN count(r) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("hop 7 (messaging, desired): TS publisher has a semantic link to the event", async () => {
    const res = await run(`
      MATCH (pub:Function {name: "publishUserCreated"})
      WHERE pub.filePath STARTS WITH $root
      MATCH (pub)-[r:USES_PROTO|PUBLISHES_TO|SUBSCRIBES_TO]-(evt)
      RETURN count(r) AS c
    `);
    expect(res.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });

  it("end-to-end (desired): Go publisher is reachable from the frontend component", async () => {
    const res = await run(`
      MATCH (frontend:Function {name: "UserDashboard"}), (pub:Function {name: "PublishUserCreated"})
      WHERE frontend.filePath STARTS WITH $root AND pub.filePath STARTS WITH $root
      MATCH p = shortestPath((frontend)-[:${SEMANTIC_RELS}*..8]-(pub))
      RETURN length(p) AS hops
    `);
    expect(res.records.length).toBeGreaterThan(0);
  });
});
