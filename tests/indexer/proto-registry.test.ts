import { describe, it, expect } from "vitest";
import { ProtoRegistry, createProtoRegistry } from "../../src/indexer/proto-registry.js";
import type { ProtoRpcDef } from "../../src/indexer/proto-registry.js";

const USER_GET: ProtoRpcDef = {
  serviceName: "UserService",
  methodName: "GetUser",
  methodCamel: "getUser",
  requestType: "GetUserRequest",
  responseType: "GetUserResponse",
  packageName: "user.v1",
  protoFile: "/protos/user.proto",
};

const USER_CREATE: ProtoRpcDef = {
  serviceName: "UserService",
  methodName: "CreateUser",
  methodCamel: "createUser",
  requestType: "CreateUserRequest",
  responseType: "CreateUserResponse",
  packageName: "user.v1",
  protoFile: "/protos/user.proto",
};

const AUTH_VALIDATE: ProtoRpcDef = {
  serviceName: "AuthService",
  methodName: "ValidateToken",
  methodCamel: "validateToken",
  requestType: "ValidateTokenRequest",
  responseType: "ValidateTokenResponse",
  packageName: "auth.v1",
  protoFile: "/protos/auth.proto",
};

describe("ProtoRegistry", () => {
  it("returns null for unregistered lookups", () => {
    const reg = createProtoRegistry();
    expect(reg.lookup("NoService", "NoMethod")).toBeNull();
    expect(reg.lookupByMethod("NoMethod")).toEqual([]);
  });

  it("registers and looks up by service + method", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    expect(reg.lookup("UserService", "GetUser")).toEqual(USER_GET);
    expect(reg.lookup("UserService", "CreateUser")).toBeNull();
  });

  it("looks up by method name (PascalCase and camelCase)", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    expect(reg.lookupByMethod("GetUser")).toEqual([USER_GET]);
    expect(reg.lookupByMethod("getUser")).toEqual([USER_GET]);
  });

  it("returns multiple defs when method name is shared across services", () => {
    const authGet: ProtoRpcDef = {
      ...AUTH_VALIDATE,
      methodName: "GetUser",
      methodCamel: "getUser",
    };
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register(authGet);
    const results = reg.lookupByMethod("GetUser");
    expect(results).toHaveLength(2);
  });

  it("is idempotent: re-registering the same def does not duplicate method lookups", () => {
    // A proto file can be parsed into the same registry more than once
    // (workspace pre-scan + per-repo indexing). Duplicate methodIndex entries
    // break callers that rely on lookupByMethod returning exactly one def.
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register(USER_GET);
    expect(reg.lookupByMethod("GetUser")).toHaveLength(1);
    expect(reg.lookupByMethod("getUser")).toHaveLength(1);
  });

  it("lists all methods for a service", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register(USER_CREATE);
    reg.register(AUTH_VALIDATE);
    const methods = reg.getServiceMethods("UserService");
    expect(methods).toHaveLength(2);
    expect(methods.map((m) => m.methodName).sort()).toEqual(["CreateUser", "GetUser"]);
  });

  it("lists all registered services", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register(AUTH_VALIDATE);
    expect(reg.getAllServices().sort()).toEqual(["AuthService", "UserService"]);
  });

  it("looks up service methods by package and service name", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register(USER_CREATE);
    reg.register(AUTH_VALIDATE);

    expect(reg.getServiceMethodsInPackage("user.v1", "UserService").map((m) => m.methodName).sort())
      .toEqual(["CreateUser", "GetUser"]);
    expect(reg.getServiceMethodsInPackage("auth.v1", "UserService")).toEqual([]);
  });

  it("looks up RPC defs by generated message type and package", () => {
    const reg = createProtoRegistry();
    reg.register(USER_GET);
    reg.register({
      ...AUTH_VALIDATE,
      methodName: "GetUser",
      methodCamel: "getUser",
      requestType: "GetUserRequest",
      responseType: "GetUserResponse",
    });

    expect(reg.lookupByMessageTypeInPackage("GetUserResponse", "user.v1")).toEqual([USER_GET]);
    expect(reg.lookupByMessageTypeInPackage("GetUserResponse", "auth.v1")).toHaveLength(1);
  });
});
