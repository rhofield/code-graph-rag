import { describe, it, expect, beforeAll } from "vitest";
import { resolve, join } from "node:path";
import { initParser, parseFile } from "../../src/indexer/parser.js";
import { createProtoRegistry } from "../../src/indexer/proto-registry.js";
import { parseProtoFile } from "../../src/indexer/proto-parser.js";
import { detectMessagePatterns } from "../../src/indexer/message-detector.js";
import type { ProtoRegistry } from "../../src/indexer/proto-registry.js";

const WORKSPACE = resolve("tests/fixtures/pubsub/workspace");

let registry: ProtoRegistry;

async function detect(relPath: string, reg: ProtoRegistry = registry) {
  const filePath = join(WORKSPACE, relPath);
  const parsed = await parseFile(filePath);
  expect(parsed).not.toBeNull();
  const annotations = detectMessagePatterns(parsed!.tree, parsed!.language, parsed!.source, filePath, reg);
  parsed!.tree.delete();
  return annotations;
}

beforeAll(async () => {
  await initParser();
  registry = createProtoRegistry();
  parseProtoFile(join(WORKSPACE, "proto/events.proto"), registry);
});

describe("Message Detector — Go", () => {
  it("annotates a function that marshals a proto message as producer", async () => {
    const annotations = await detect("backend-go/publisher.go");
    const producer = annotations.find((a) => a.functionName === "PublishUserCreated");
    expect(producer).toBeDefined();
    expect(producer!.role).toBe("producer");
    expect(producer!.messageName).toBe("UserCreated");
    expect(producer!.packageName).toBe("events.v1");
  });

  it("does not annotate functions that never reference a registered message", async () => {
    const annotations = await detect("backend-go/publisher.go");
    expect(annotations.find((a) => a.functionName === "NewPublisher")).toBeUndefined();
  });
});

describe("Message Detector — TypeScript", () => {
  it("annotates a function that serializes a proto message as producer", async () => {
    const annotations = await detect("backend-ts/src/publisher.ts");
    const producer = annotations.find((a) => a.functionName === "publishUserCreated");
    expect(producer).toBeDefined();
    expect(producer!.role).toBe("producer");
    expect(producer!.messageName).toBe("UserCreated");
  });

  it("annotates a function that deserializes a proto message as consumer", async () => {
    const annotations = await detect("graph-layer/src/subscriber.ts");
    const consumer = annotations.find((a) => a.functionName === "handleUserCreated");
    expect(consumer).toBeDefined();
    expect(consumer!.role).toBe("consumer");
    expect(consumer!.messageName).toBe("UserCreated");
  });

  it("annotates type-only usage with role 'uses'", async () => {
    const annotations = await detect("graph-layer/src/store.ts");
    const names = annotations.map((a) => `${a.functionName}:${a.role}`).sort();
    expect(names).toEqual(["getCachedUser:uses", "saveCachedUser:uses"]);
  });

  it("skips files without proto-ish imports even when names collide", async () => {
    // The generated stub defines UserCreated but imports nothing proto-ish.
    const annotations = await detect("graph-layer/src/gen/events_pb.ts");
    expect(annotations).toEqual([]);
  });

  it("skips frontend files with no proto imports", async () => {
    const annotations = await detect("frontend/src/UserDashboard.tsx");
    expect(annotations).toEqual([]);
  });
});

describe("Message Detector — gate", () => {
  it("returns empty when the registry has no messages", async () => {
    const emptyReg = createProtoRegistry();
    const annotations = await detect("graph-layer/src/subscriber.ts", emptyReg);
    expect(annotations).toEqual([]);
  });
});
