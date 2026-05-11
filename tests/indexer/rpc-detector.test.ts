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

describe("RPC Detector — Go", () => {
  it("detects handler methods via embedded Unimplemented*Server field", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "go-handler.go"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "go-handler.go", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(2);
    expect(handlers.find((h) => h.methodName === "GetUser")).toBeDefined();
    expect(handlers.find((h) => h.methodName === "CreateUser")).toBeDefined();
    expect(handlers[0].serviceName).toBe("UserService");
  });

  it("does NOT annotate structs lacking Unimplemented*Server embedding", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "go-false-positive.go"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "go-false-positive.go", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(0);
  });

  it("detects caller via method call on client object", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "go-caller.go"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "go-caller.go", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0].functionName).toBe("fetchUser");
    expect(callers[0].serviceName).toBe("UserService");
    expect(callers[0].methodName).toBe("GetUser");
  });
});

describe("RPC Detector — Python", () => {
  it("detects handler methods via Servicer base class", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "python-handler.py"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "python-handler.py", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(2);
    expect(handlers.find((h) => h.methodName === "GetUser")).toBeDefined();
    expect(handlers.find((h) => h.methodName === "CreateUser")).toBeDefined();
  });

  it("detects caller via stub method call", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "python-caller.py"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "python-caller.py", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0].functionName).toBe("fetch_user");
    expect(callers[0].serviceName).toBe("UserService");
    expect(callers[0].methodName).toBe("GetUser");
  });

  it("disambiguates snake_case receiver by most-specific-token-match", async () => {
    const ambiguousReg = createProtoRegistry();
    parseProtoSource(`
      syntax = "proto3";
      package user.v1;
      service UserService {
        rpc GetUser (Req) returns (Resp);
      }
      service UserServiceHelper {
        rpc GetUser (Req) returns (Resp);
      }
    `, "/protos/ambiguous.proto", ambiguousReg);

    const parsed = await parseFile(resolve(FIXTURES, "python-ambiguous.py"));
    const ann = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "python-ambiguous.py", ambiguousReg);
    parsed!.tree.delete();

    const callers = ann.filter((a) => a.role === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0].serviceName).toBe("UserServiceHelper");
    expect(callers[0].methodName).toBe("GetUser");
  });
});

describe("RPC Detector — TypeScript", () => {
  it("detects handler methods via implements clause", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "ts-handler.ts"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "ts-handler.ts", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(2);
    const getUser = handlers.find((h) => h.methodName === "GetUser");
    expect(getUser).toBeDefined();
    expect(getUser!.functionName).toBe("getUser");
    expect(getUser!.serviceName).toBe("UserService");
  });

  it("detects caller via client method call (camelCase)", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "ts-caller.ts"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "ts-caller.ts", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    const loadUserCaller = callers.find((c) => c.functionName === "loadUser");
    expect(loadUserCaller).toBeDefined();
    expect(loadUserCaller!.serviceName).toBe("UserService");
    expect(loadUserCaller!.methodName).toBe("GetUser");
  });

  it("detects caller inside a named arrow function (const name = () => ...)", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "ts-caller.ts"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "ts-caller.ts", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    const createUserCaller = callers.find((c) => c.functionName === "createUser");
    expect(createUserCaller).toBeDefined();
    expect(createUserCaller!.methodName).toBe("CreateUser");
  });

  it("disambiguates by exact receiver token, not substring match", async () => {
    const ambiguousReg = createProtoRegistry();
    parseProtoSource(`
      syntax = "proto3";
      package user.v1;
      service UserService {
        rpc GetUser (Req) returns (Resp);
      }
      service UserServiceHelper {
        rpc GetUser (Req) returns (Resp);
      }
    `, "/protos/ambiguous.proto", ambiguousReg);

    const parsed = await parseFile(resolve(FIXTURES, "ts-ambiguous.ts"));
    const ann = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "ts-ambiguous.ts", ambiguousReg);
    parsed!.tree.delete();

    const callers = ann.filter((a) => a.role === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0].serviceName).toBe("UserServiceHelper");
  });

  it("detects RPC calls inside GraphQL resolver object property arrows using generated node packages", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "ts-graphql-resolver.ts"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "ts-graphql-resolver.ts", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    expect(callers).toContainEqual({
      functionName: "user",
      filePath: "ts-graphql-resolver.ts",
      role: "caller",
      serviceName: "UserService",
      methodName: "GetUser",
    });
  });
});

describe("RPC Detector — Java", () => {
  it("detects handler methods via extends ImplBase", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "java-handler.java"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "java-handler.java", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(2);
    const getUser = handlers.find((h) => h.methodName === "GetUser");
    expect(getUser).toBeDefined();
    expect(getUser!.functionName).toBe("getUser");
    expect(getUser!.serviceName).toBe("UserService");
  });

  it("detects caller via stub method call (camelCase)", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "java-caller.java"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "java-caller.java", registry);
    parsed!.tree.delete();

    const callers = annotations.filter((a) => a.role === "caller");
    expect(callers).toHaveLength(1);
    expect(callers[0].functionName).toBe("fetchUserName");
    expect(callers[0].serviceName).toBe("UserService");
    expect(callers[0].methodName).toBe("GetUser");
  });
});

describe("RPC Detector — false positive rejection", () => {
  it("does not annotate non-gRPC file with matching function name", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "not-grpc.ts"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "not-grpc.ts", registry);
    parsed!.tree.delete();
    expect(annotations).toEqual([]);
  });
});
