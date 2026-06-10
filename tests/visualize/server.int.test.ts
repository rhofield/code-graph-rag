// tests/visualize/server.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { createTestConnection, TEST_NEO4J_CONFIG } from "../helpers/test-db.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository } from "../../src/indexer/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { startVisualizationServerForTest } from "../../src/visualize/server.js";
import type { Server } from "node:http";

const INTEGRATION = !!process.env.INTEGRATION;
const PORT = 33334; // unique to avoid clashing with default 3333

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(`http://localhost:${PORT}${path}`);
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

describe.skipIf(!INTEGRATION)("visualize server endpoints", () => {
  let server: Server | undefined;

  beforeAll(async () => {
    const db = createTestConnection();
    await setupSchema(db);

    // Index a fixture so the graph has known content
    await indexRepository(
      db,
      resolve("tests/fixtures/microservices/auth-service"),
      DEFAULT_CONFIG.index
    );
    await db.close();

    server = await startVisualizationServerForTest({
      neo4jConfig: {
        ...TEST_NEO4J_CONFIG,
        managed: false,
      },
      port: PORT,
      filter: {},
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("GET /api/graph returns repo overview by default", async () => {
    const { status, body } = await getJson("/api/graph");
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    expect(body.nodes.some((n: any) => n.group === "Repository")).toBe(true);
    expect(body.nodes.some((n: any) => n.group === "File")).toBe(true);
    expect(body.nodes.every((n: any) => n.group !== "Function")).toBe(true);
  });

  it("GET /api/graph?file=... returns the file's symbols", async () => {
    // Find a known file from the fixture first
    const overview = await getJson("/api/graph");
    const file = overview.body.nodes.find(
      (n: any) => n.group === "File" && n.properties.relativePath
    );
    expect(file).toBeDefined();

    const { status, body } = await getJson(
      `/api/graph?file=${encodeURIComponent(file.properties.relativePath)}`
    );
    expect(status).toBe(200);
    expect(body.nodes.some((n: any) => n.group === "File")).toBe(true);
    // At least one symbol should appear (Function or Class)
    expect(
      body.nodes.some((n: any) => n.group === "Function" || n.group === "Class")
    ).toBe(true);
  });

  it("GET /api/graph?function=validateToken returns the function + neighbors", async () => {
    const { status, body } = await getJson("/api/graph?function=validateToken");
    expect(status).toBe(200);
    expect(body.nodes.some((n: any) => n.group === "Function" && n.label === "validateToken")).toBe(
      true
    );
  });

  it("GET /api/expand?type=file&filePath=... returns symbols only", async () => {
    const overview = await getJson("/api/graph");
    const file = overview.body.nodes.find(
      (n: any) => n.group === "File" && n.properties.path
    );
    expect(file).toBeDefined();

    const { status, body } = await getJson(
      `/api/expand?type=file&filePath=${encodeURIComponent(file.properties.path)}`
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("GET /api/expand?type=garbage returns 400", async () => {
    const { status, body } = await getJson("/api/expand?type=garbage");
    expect(status).toBe(400);
    expect(body.error).toContain("unknown expand type");
  });

  it("GET /api/search?q=valid returns matching nodes", async () => {
    const { status, body } = await getJson("/api/search?q=valid");
    expect(status).toBe(200);
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("GET /api/graph?file=does-not-exist returns 200 with empty nodes", async () => {
    const { status, body } = await getJson("/api/graph?file=does-not-exist.ts");
    expect(status).toBe(200);
    expect(body.nodes).toEqual([]);
  });
});
