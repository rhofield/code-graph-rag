import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { initParser, parseFile } from "../../src/indexer/parser.js";
import { createProtoRegistry } from "../../src/indexer/proto-registry.js";
import { parseProtoSource } from "../../src/indexer/proto-parser.js";
import { detectRpcPatterns } from "../../src/indexer/rpc-detector.js";
import type { ProtoRegistry } from "../../src/indexer/proto-registry.js";

const FIXTURES = resolve("tests/fixtures/grpc");

const PROTO_SOURCE = `
  syntax = "proto3";
  package user.v1;
  service UserService {
    rpc GetUser (GetUserRequest) returns (GetUserResponse);
    rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
  }
`;

let registry: ProtoRegistry;

beforeAll(async () => {
  await initParser();
  registry = createProtoRegistry();
  parseProtoSource(PROTO_SOURCE, "/protos/user.proto", registry);
});

describe("RPC Detector — gate check", () => {
  it("skips files without gRPC imports", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "not-grpc.ts"));
    expect(parsed).not.toBeNull();
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "not-grpc.ts", registry);
    expect(annotations).toEqual([]);
    parsed!.tree.delete();
  });

  it("returns empty when registry has no services", async () => {
    const emptyReg = createProtoRegistry();
    const parsed = await parseFile(resolve(FIXTURES, "go-handler.go"));
    expect(parsed).not.toBeNull();
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "go-handler.go", emptyReg);
    expect(annotations).toEqual([]);
    parsed!.tree.delete();
  });
});
