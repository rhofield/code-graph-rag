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

  it("registers top-level messages from a message-only proto", () => {
    const source = `
      syntax = "proto3";
      package events.v1;

      message UserCreated {
        string id = 1;
        string name = 2;
      }

      message UserDeleted {
        string id = 1;
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/events.proto", reg);

    expect(reg.getAllServices()).toEqual([]);
    const names = reg.getAllMessages().map((m) => m.messageName).sort();
    expect(names).toEqual(["UserCreated", "UserDeleted"]);

    const defs = reg.lookupMessage("UserCreated");
    expect(defs).toHaveLength(1);
    expect(defs[0].packageName).toBe("events.v1");
    expect(defs[0].protoFile).toBe("/protos/events.proto");
  });

  it("registers messages alongside services", () => {
    const source = `
      syntax = "proto3";
      package user.v1;

      service UserService {
        rpc GetUser (GetUserRequest) returns (GetUserResponse);
      }

      message GetUserRequest { string id = 1; }
      message GetUserResponse { string id = 1; string name = 2; }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/user.proto", reg);

    expect(reg.lookup("UserService", "GetUser")).not.toBeNull();
    expect(reg.lookupMessage("GetUserRequest")).toHaveLength(1);
    expect(reg.lookupMessage("GetUserResponse")).toHaveLength(1);
  });

  it("registers nested messages and deduplicates re-registration", () => {
    const source = `
      syntax = "proto3";
      package events.v1;

      message Outer {
        message Inner { string id = 1; }
        Inner inner = 1;
      }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/events.proto", reg);
    parseProtoSource(source, "/protos/events.proto", reg);

    const names = reg.getAllMessages().map((m) => m.messageName).sort();
    expect(names).toEqual(["Inner", "Outer"]);
    expect(reg.lookupMessage("Outer")).toHaveLength(1);
  });

  it("ignores message names mentioned only in comments", () => {
    const source = `
      syntax = "proto3";
      package events.v1;

      // message Phantom { string id = 1; }
      message Real { string id = 1; }
    `;
    const reg = createProtoRegistry();
    parseProtoSource(source, "/protos/events.proto", reg);

    expect(reg.getAllMessages().map((m) => m.messageName)).toEqual(["Real"]);
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
