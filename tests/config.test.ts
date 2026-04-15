import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type Config, DEFAULT_CONFIG } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cgr-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://localhost:7687");
    expect(config.neo4j.managed).toBe(true);
    expect(config.index.exclude).toContain("node_modules");
  });

  it("merges repo config file over defaults", () => {
    const repoConfig = {
      neo4j: { uri: "bolt://custom:7687" },
      index: { exclude: ["vendor"] },
    };
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify(repoConfig)
    );
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://custom:7687");
    expect(config.neo4j.managed).toBe(true); // default preserved
    expect(config.index.exclude).toContain("vendor");
  });

  it("respects NEO4J_URI environment variable", () => {
    process.env.NEO4J_URI = "bolt://env-host:7687";
    const config = loadConfig(tempDir);
    expect(config.neo4j.uri).toBe("bolt://env-host:7687");
    delete process.env.NEO4J_URI;
  });

  it("applies default discovery settings", () => {
    const config = loadConfig(tempDir);
    expect(config.discovery.ttlHours).toBe(24);
    expect(config.discovery.maxDepth).toBe(6);
    expect(config.lastDiscoveredAt).toBeUndefined();
  });

  it("merges user-supplied discovery overrides", () => {
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify({ discovery: { ttlHours: 1 } })
    );
    const config = loadConfig(tempDir);
    expect(config.discovery.ttlHours).toBe(1);
    expect(config.discovery.maxDepth).toBe(6); // default preserved
  });

  it("reads lastDiscoveredAt when present", () => {
    const iso = "2026-04-15T12:00:00.000Z";
    writeFileSync(
      join(tempDir, ".rho-graph.json"),
      JSON.stringify({ lastDiscoveredAt: iso })
    );
    const config = loadConfig(tempDir);
    expect(config.lastDiscoveredAt).toBe(iso);
  });
});
