import { describe, it, expect } from "vitest";
import { createProtoRegistry } from "../../src/indexer/proto-registry.js";
import { parseProtoSource } from "../../src/indexer/proto-parser.js";

describe("parseProtoSource", () => {
  it("extracts a single service with one RPC", () => {
    const source = `
      syntax = "proto3";
      package user.v1;

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);

    const def = reg.lookup("UserService", "GetUser");
    expect(def).not.toBeNull();
    expect(def!.serviceName).toBe("UserService");
    expect(def!.methodName).toBe("GetUser");
    expect(def!.methodCamel).toBe("getUser");
    expect(def!.requestType).toBe("GetUserRequest");
    expect(def!.responseType).toBe("GetUserResponse");
    expect(def!.packageName).toBe("user.v1");
    expect(def!.protoFile).toBe("/protos/user.proto");
  });

  it("extracts multiple RPCs from one service", () => {
    const source = `
      syntax = "proto3";
      package user.v1;

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
        rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
        rpc DeleteUser (DeleteUserRequest) returns (DeleteUserResponse);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);

    expect(reg.getServiceMethods("UserService")).toHaveLength(3);
    expect(reg.lookup("UserService", "CreateUser")).not.toBeNull();
    expect(reg.lookup("UserService", "DeleteUser")).not.toBeNull();
  });

  it("extracts multiple services from one file", () => {
    const source = `
      syntax = "proto3";
      package api.v1;

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
      }

      service AuthService {
        rpc ValidateToken (ValidateTokenRequest) returns (ValidateTokenResponse);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/api.proto", reg);

    expect(reg.getAllServices().sort()).toEqual(["AuthService", "UserService"]);
    expect(reg.lookup("AuthService", "ValidateToken")).not.toBeNull();
  });

  it("handles streaming RPCs", () => {
    const source = `
      syntax = "proto3";
      package stream.v1;

      service StreamService {
        rpc ServerStream (Request) returns (stream Response);
        rpc ClientStream (stream Request) returns (Response);
        rpc BidiStream (stream Request) returns (stream Response);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/stream.proto", reg);

    expect(reg.getServiceMethods("StreamService")).toHaveLength(3);
    expect(reg.lookup("StreamService", "ServerStream")!.responseType).toBe("Response");
    expect(reg.lookup("StreamService", "ClientStream")!.requestType).toBe("Request");
  });

  it("ignores comments", () => {
    const source = `
      syntax = "proto3";
      package user.v1;

      // This is a comment
      service UserService {
        // rpc FakeMethod (Fake) returns (Fake);
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
        /* rpc AnotherFake (Fake) returns (Fake); */
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);

    expect(reg.getServiceMethods("UserService")).toHaveLength(1);
    expect(reg.lookup("UserService", "GetUser")).not.toBeNull();
  });

  it("handles missing package", () => {
    const source = `
      syntax = "proto3";

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);

    expect(reg.lookup("UserService", "GetUser")!.packageName).toBe("");
  });

  it("handles empty service body", () => {
    const source = `
      syntax = "proto3";
      package empty.v1;

      service EmptyService {}
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/empty.proto", reg);

    expect(reg.getAllServices()).toEqual([]);
    expect(reg.getServiceMethods("EmptyService")).toEqual([]);
  });

  it("handles nested brace blocks inside service (e.g. inline message)", () => {
    const source = `
      syntax = "proto3";
      package user.v1;

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
        message NestedMsg { string id = 1; }
        rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);
    expect(reg.getServiceMethods("UserService")).toHaveLength(2);
    expect(reg.lookup("UserService", "GetUser")).not.toBeNull();
    expect(reg.lookup("UserService", "CreateUser")).not.toBeNull();
  });
});
