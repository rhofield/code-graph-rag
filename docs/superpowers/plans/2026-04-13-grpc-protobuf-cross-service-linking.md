# gRPC/Protobuf Cross-Service Linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable rho-graph to detect and link gRPC RPC calls across microservices by parsing `.proto` files and using per-language structural heuristics to create `RPC_CALLS` edges between caller and handler functions in Neo4j.

**Architecture:** Proto files are regex-parsed into an in-memory `ProtoRegistry` at the start of each `indexRepository` call. Source files are then analyzed by an `RpcDetector` that uses AST-based structural heuristics (per-language import patterns, class inheritance, receiver types) to identify handler and caller functions. Handler and caller metadata is persisted as properties on `Function` nodes in Neo4j. A stateless `RpcLinker` runs a Cypher query at the end of indexing to create `RPC_CALLS` edges by joining callers to handlers. Cross-repo linking works because the linker queries the full graph, not just the current run.

**Tech Stack:** TypeScript, web-tree-sitter (existing), Neo4j/Cypher (existing), vitest (existing)

**Spec:** `docs/superpowers/specs/2026-04-13-grpc-protobuf-cross-service-linking-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/indexer/proto-registry.ts` | `ProtoRegistry` class — in-memory store for parsed service/RPC definitions |
| `src/indexer/proto-parser.ts` | Regex-based `.proto` file parser, populates `ProtoRegistry` |
| `src/indexer/rpc-detector.ts` | Per-language AST-based detection of gRPC handlers and callers |
| `src/indexer/rpc-linker.ts` | Orchestrates writing RPC metadata to Neo4j and resolving `RPC_CALLS` edges |
| `tests/indexer/proto-registry.test.ts` | Unit tests for ProtoRegistry |
| `tests/indexer/proto-parser.test.ts` | Unit tests for proto parser |
| `tests/indexer/rpc-detector.test.ts` | Unit tests for RPC detector (all 4 languages) |
| `tests/fixtures/grpc/user.proto` | Shared proto fixture defining UserService |
| `tests/fixtures/grpc/go-handler.go` | Go gRPC handler fixture |
| `tests/fixtures/grpc/go-caller.go` | Go gRPC caller fixture |
| `tests/fixtures/grpc/python-handler.py` | Python gRPC handler fixture |
| `tests/fixtures/grpc/python-caller.py` | Python gRPC caller fixture |
| `tests/fixtures/grpc/ts-handler.ts` | TypeScript gRPC handler fixture |
| `tests/fixtures/grpc/ts-caller.ts` | TypeScript gRPC caller fixture |
| `tests/fixtures/grpc/java-handler.java` | Java gRPC handler fixture |
| `tests/fixtures/grpc/java-caller.java` | Java gRPC caller fixture |
| `tests/fixtures/grpc/not-grpc.ts` | Non-gRPC file with `GetUser` function (false positive test) |
| `tests/fixtures/grpc/monorepo/proto/user.proto` | Mono-repo topology proto fixture |
| `tests/fixtures/grpc/monorepo/user-service/src/handler.go` | Mono-repo Go handler |
| `tests/fixtures/grpc/monorepo/auth-service/src/caller.py` | Mono-repo Python caller |
| `tests/fixtures/grpc/monorepo/auth-service/src/not-grpc.py` | Mono-repo false positive |
| `tests/fixtures/grpc/multirepo/proto-repo/user/v1/user.proto` | Multi-repo proto fixture |
| `tests/fixtures/grpc/multirepo/service-a/src/caller.ts` | Multi-repo TS caller |
| `tests/fixtures/grpc/multirepo/service-b/src/handler.java` | Multi-repo Java handler |

### Modified Files

| File | Change |
|---|---|
| `src/indexer/parser.ts` | Add `".proto": "proto"` to `EXTENSION_MAP` |
| `src/db/queries.ts` | Add `batchSetRpcHandlerMeta`, `batchSetRpcCallerMeta`, `resolveRpcEdges` |
| `src/indexer/parallel-pipeline.ts` | Accept optional `rpcDetectFn`, return `rpcAnnotations` in result |
| `src/indexer/index.ts` | Proto pre-processing, RPC detection integration, linker orchestration, `protoRegistry` option |
| `tests/integration/microservices.test.ts` | Add monorepo and multirepo gRPC integration tests |

---

### Task 1: ProtoRegistry

**Files:**
- Create: `src/indexer/proto-registry.ts`
- Test: `tests/indexer/proto-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/indexer/proto-registry.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/proto-registry.test.ts`
Expected: FAIL — module `proto-registry.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/indexer/proto-registry.ts

export interface ProtoRpcDef {
  serviceName: string;
  methodName: string;
  methodCamel: string;
  requestType: string;
  responseType: string;
  packageName: string;
  protoFile: string;
}

export class ProtoRegistry {
  private services = new Map<string, Map<string, ProtoRpcDef>>();
  private methodIndex = new Map<string, ProtoRpcDef[]>();

  register(def: ProtoRpcDef): void {
    if (!this.services.has(def.serviceName)) {
      this.services.set(def.serviceName, new Map());
    }
    this.services.get(def.serviceName)!.set(def.methodName, def);

    for (const key of [def.methodName, def.methodCamel]) {
      if (!this.methodIndex.has(key)) {
        this.methodIndex.set(key, []);
      }
      this.methodIndex.get(key)!.push(def);
    }
  }

  lookup(serviceName: string, methodName: string): ProtoRpcDef | null {
    return this.services.get(serviceName)?.get(methodName) ?? null;
  }

  lookupByMethod(methodName: string): ProtoRpcDef[] {
    return this.methodIndex.get(methodName) ?? [];
  }

  getServiceMethods(serviceName: string): ProtoRpcDef[] {
    const methods = this.services.get(serviceName);
    return methods ? [...methods.values()] : [];
  }

  getAllServices(): string[] {
    return [...this.services.keys()];
  }
}

export function createProtoRegistry(): ProtoRegistry {
  return new ProtoRegistry();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/proto-registry.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/proto-registry.ts tests/indexer/proto-registry.test.ts
git commit -m "feat: add ProtoRegistry for in-memory proto RPC definitions"
```

---

### Task 2: Proto Parser

**Files:**
- Create: `src/indexer/proto-parser.ts`
- Test: `tests/indexer/proto-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/indexer/proto-parser.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/proto-parser.test.ts`
Expected: FAIL — module `proto-parser.js` does not exist

- [ ] **Step 3: Write the implementation**

```typescript
// src/indexer/proto-parser.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProtoRegistry } from "./proto-registry.js";

function toCamelCase(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function parseProtoSource(
  source: string,
  filePath: string,
  registry: ProtoRegistry
): void {
  // Strip comments
  const stripped = source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  // Extract package name
  const pkgMatch = stripped.match(/package\s+([\w.]+)\s*;/);
  const packageName = pkgMatch ? pkgMatch[1] : "";

  // Extract services and their RPCs
  const serviceRegex = /service\s+(\w+)\s*\{([^}]*)\}/g;
  const rpcRegex = /rpc\s+(\w+)\s*\(\s*(?:stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g;

  let serviceMatch: RegExpExecArray | null;
  while ((serviceMatch = serviceRegex.exec(stripped)) !== null) {
    const serviceName = serviceMatch[1];
    const serviceBody = serviceMatch[2];

    let rpcMatch: RegExpExecArray | null;
    rpcRegex.lastIndex = 0;
    while ((rpcMatch = rpcRegex.exec(serviceBody)) !== null) {
      registry.register({
        serviceName,
        methodName: rpcMatch[1],
        methodCamel: toCamelCase(rpcMatch[1]),
        requestType: rpcMatch[2],
        responseType: rpcMatch[3],
        packageName,
        protoFile: filePath,
      });
    }
  }
}

export function parseProtoFile(
  filePath: string,
  registry: ProtoRegistry
): void {
  const absPath = resolve(filePath);
  const source = readFileSync(absPath, "utf-8");
  parseProtoSource(source, absPath, registry);
}

export function parseProtoFiles(
  filePaths: string[],
  registry: ProtoRegistry
): void {
  for (const fp of filePaths) {
    parseProtoFile(fp, registry);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/proto-parser.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/proto-parser.ts tests/indexer/proto-parser.test.ts
git commit -m "feat: add regex-based proto file parser"
```

---

### Task 3: Test Fixtures

**Files:**
- Create: all fixture files in `tests/fixtures/grpc/`

- [ ] **Step 1: Create the shared proto fixture**

```protobuf
// tests/fixtures/grpc/user.proto
syntax = "proto3";

package user.v1;

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
}

message GetUserRequest {
  string id = 1;
}

message GetUserResponse {
  string id = 1;
  string name = 2;
}

message CreateUserRequest {
  string name = 1;
}

message CreateUserResponse {
  string id = 1;
}
```

- [ ] **Step 2: Create Go handler fixture**

```go
// tests/fixtures/grpc/go-handler.go
package main

import (
	"context"
	pb "myproject/proto/user/v1"
)

type UserServiceServer struct {
	pb.UnimplementedUserServiceServer
}

func (s *UserServiceServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
	return &pb.GetUserResponse{Id: req.Id, Name: "Alice"}, nil
}

func (s *UserServiceServer) CreateUser(ctx context.Context, req *pb.CreateUserRequest) (*pb.CreateUserResponse, error) {
	return &pb.CreateUserResponse{Id: "new-id"}, nil
}
```

- [ ] **Step 3: Create Go caller fixture**

```go
// tests/fixtures/grpc/go-caller.go
package main

import (
	"context"
	"fmt"
	pb "myproject/proto/user/v1"
	"google.golang.org/grpc"
)

func fetchUser(ctx context.Context, client pb.UserServiceClient, id string) {
	resp, err := client.GetUser(ctx, &pb.GetUserRequest{Id: id})
	if err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println(resp.Name)
}
```

- [ ] **Step 4: Create Python handler fixture**

```python
# tests/fixtures/grpc/python-handler.py
import user_pb2
import user_pb2_grpc

class UserServiceServicer(user_pb2_grpc.UserServiceServicer):
    def GetUser(self, request, context):
        return user_pb2.GetUserResponse(id=request.id, name="Alice")

    def CreateUser(self, request, context):
        return user_pb2.CreateUserResponse(id="new-id")
```

- [ ] **Step 5: Create Python caller fixture**

```python
# tests/fixtures/grpc/python-caller.py
import grpc
import user_pb2
import user_pb2_grpc

def fetch_user(channel, user_id):
    stub = user_pb2_grpc.UserServiceStub(channel)
    response = stub.GetUser(user_pb2.GetUserRequest(id=user_id))
    return response.name
```

- [ ] **Step 6: Create TypeScript handler fixture**

```typescript
// tests/fixtures/grpc/ts-handler.ts
import { UserServiceServer } from "./generated/user_grpc_pb";
import { GetUserRequest, GetUserResponse, CreateUserRequest, CreateUserResponse } from "./generated/user_pb";

class UserServiceImpl implements UserServiceServer {
  getUser(req: GetUserRequest): GetUserResponse {
    return new GetUserResponse().setId(req.getId()).setName("Alice");
  }

  createUser(req: CreateUserRequest): CreateUserResponse {
    return new CreateUserResponse().setId("new-id");
  }
}
```

- [ ] **Step 7: Create TypeScript caller fixture**

```typescript
// tests/fixtures/grpc/ts-caller.ts
import { UserServiceClient } from "./generated/user_grpc_pb";

async function loadUser(client: UserServiceClient, userId: string) {
  const response = await client.getUser({ id: userId });
  return response.name;
}
```

- [ ] **Step 8: Create Java handler fixture**

```java
// tests/fixtures/grpc/java-handler.java
package com.example.userservice;

import com.example.proto.UserServiceGrpc;
import com.example.proto.User.GetUserRequest;
import com.example.proto.User.GetUserResponse;
import com.example.proto.User.CreateUserRequest;
import com.example.proto.User.CreateUserResponse;

public class UserServiceImpl extends UserServiceGrpc.UserServiceImplBase {
    @Override
    public GetUserResponse getUser(GetUserRequest request) {
        return GetUserResponse.newBuilder()
            .setId(request.getId())
            .setName("Alice")
            .build();
    }

    @Override
    public CreateUserResponse createUser(CreateUserRequest request) {
        return CreateUserResponse.newBuilder()
            .setId("new-id")
            .build();
    }
}
```

- [ ] **Step 9: Create Java caller fixture**

```java
// tests/fixtures/grpc/java-caller.java
package com.example.gateway;

import com.example.proto.UserServiceGrpc;
import com.example.proto.User.GetUserRequest;
import com.example.proto.User.GetUserResponse;
import io.grpc.ManagedChannel;

public class UserClient {
    private final UserServiceGrpc.UserServiceBlockingStub stub;

    public UserClient(ManagedChannel channel) {
        this.stub = UserServiceGrpc.newBlockingStub(channel);
    }

    public String fetchUserName(String userId) {
        GetUserResponse response = stub.getUser(
            GetUserRequest.newBuilder().setId(userId).build()
        );
        return response.getName();
    }
}
```

- [ ] **Step 10: Create false-positive fixture (non-gRPC file with matching function name)**

```typescript
// tests/fixtures/grpc/not-grpc.ts
import { db } from "./database";

export function GetUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}

export function fetchUser(id: string) {
  const user = GetUser(id);
  return user;
}
```

- [ ] **Step 11: Commit fixtures**

```bash
git add tests/fixtures/grpc/
git commit -m "test: add gRPC fixture files for all 4 languages"
```

---

### Task 4: RPC Detector — Import Gate Check

**Files:**
- Create: `src/indexer/rpc-detector.ts`
- Test: `tests/indexer/rpc-detector.test.ts`

This task implements the module skeleton with gate checks. Handler/caller detection bodies are stubs until Task 5.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/indexer/rpc-detector.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts`
Expected: FAIL — module `rpc-detector.js` does not exist

- [ ] **Step 3: Write the initial implementation with gate check and empty detection stubs**

```typescript
// src/indexer/rpc-detector.ts
import type Parser from "web-tree-sitter";
import type { ProtoRegistry } from "./proto-registry.js";

export interface RpcAnnotation {
  functionName: string;
  filePath: string;
  role: "caller" | "handler";
  serviceName: string;
  methodName: string;
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

// --- Gate checks: does this file import gRPC-generated code? ---

function hasGrpcImportsGo(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_declaration") {
      const text = getNodeText(child, source);
      if (/pb["'\s]|proto["'\s]|grpc["'\s]/i.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsPython(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_from_statement" || child.type === "import_statement") {
      const text = getNodeText(child, source);
      if (/_pb2_grpc|_pb2/.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsTypeScript(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_statement") {
      const text = getNodeText(child, source);
      if (/_grpc_pb|ServiceClient|ServiceServer|grpc/.test(text)) return true;
    }
  }
  return false;
}

function hasGrpcImportsJava(root: Parser.SyntaxNode, source: string): boolean {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === "import_declaration") {
      const text = getNodeText(child, source);
      if (/Grpc[.;\s]|\.grpc\./.test(text)) return true;
    }
  }
  return false;
}

// --- Shared call-in-body finder for Go, Python, TypeScript ---

function findCallsInBody(
  node: Parser.SyntaxNode,
  source: string,
  enclosingFuncName: string,
  filePath: string,
  registry: ProtoRegistry,
  out: RpcAnnotation[]
): void {
  if (node.type === "call_expression") {
    const fnNode = node.childForFieldName("function");
    if (fnNode && (
      fnNode.type === "selector_expression" ||
      fnNode.type === "member_expression" ||
      fnNode.type === "attribute"
    )) {
      const fieldNode =
        fnNode.childForFieldName("field") ||
        fnNode.childForFieldName("property") ||
        fnNode.childForFieldName("attribute");
      if (fieldNode) {
        const callName = getNodeText(fieldNode, source);
        const defs = registry.lookupByMethod(callName);
        if (defs.length === 1) {
          out.push({
            functionName: enclosingFuncName,
            filePath,
            role: "caller",
            serviceName: defs[0].serviceName,
            methodName: defs[0].methodName,
          });
        } else if (defs.length > 1) {
          const objNode = fnNode.childForFieldName("operand") || fnNode.childForFieldName("object");
          if (objNode) {
            const objText = getNodeText(objNode, source).toLowerCase();
            for (const def of defs) {
              if (objText.includes(def.serviceName.toLowerCase().replace("service", ""))) {
                out.push({
                  functionName: enclosingFuncName,
                  filePath,
                  role: "caller",
                  serviceName: def.serviceName,
                  methodName: def.methodName,
                });
                break;
              }
            }
          }
        }
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    findCallsInBody(node.child(i)!, source, enclosingFuncName, filePath, registry, out);
  }
}

// --- Java-specific call finder (method_invocation instead of call_expression) ---

function findJavaCallsInBody(
  node: Parser.SyntaxNode,
  source: string,
  enclosingFuncName: string,
  filePath: string,
  registry: ProtoRegistry,
  out: RpcAnnotation[]
): void {
  if (node.type === "method_invocation") {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      const callName = getNodeText(nameNode, source);
      const defs = registry.lookupByMethod(callName);
      if (defs.length === 1) {
        out.push({
          functionName: enclosingFuncName,
          filePath,
          role: "caller",
          serviceName: defs[0].serviceName,
          methodName: defs[0].methodName,
        });
      } else if (defs.length > 1) {
        const objNode = node.childForFieldName("object");
        if (objNode) {
          const objText = getNodeText(objNode, source).toLowerCase();
          for (const def of defs) {
            if (objText.includes(def.serviceName.toLowerCase().replace("service", ""))) {
              out.push({
                functionName: enclosingFuncName,
                filePath,
                role: "caller",
                serviceName: def.serviceName,
                methodName: def.methodName,
              });
              break;
            }
          }
        }
      }
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    findJavaCallsInBody(node.child(i)!, source, enclosingFuncName, filePath, registry, out);
  }
}

// --- Handler/caller detection stubs (filled in Task 5) ---

function detectGoHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectGoCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectPythonHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectPythonCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectTypeScriptHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectTypeScriptCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectJavaHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}
function detectJavaCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {}

// --- Per-language dispatch ---

function detectGo(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsGo(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectGoHandlers(tree.rootNode, source, filePath, registry, out);
  detectGoCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectPython(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsPython(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectPythonHandlers(tree.rootNode, source, filePath, registry, out);
  detectPythonCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectTypeScript(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsTypeScript(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectTypeScriptHandlers(tree.rootNode, source, filePath, registry, out);
  detectTypeScriptCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

function detectJava(tree: Parser.Tree, source: string, filePath: string, registry: ProtoRegistry): RpcAnnotation[] {
  if (!hasGrpcImportsJava(tree.rootNode, source)) return [];
  const out: RpcAnnotation[] = [];
  detectJavaHandlers(tree.rootNode, source, filePath, registry, out);
  detectJavaCalls(tree.rootNode, source, filePath, registry, out);
  return out;
}

// --- Main entry point ---

export function detectRpcPatterns(
  tree: Parser.Tree,
  language: string,
  source: string,
  filePath: string,
  registry: ProtoRegistry
): RpcAnnotation[] {
  if (registry.getAllServices().length === 0) return [];

  switch (language) {
    case "go": return detectGo(tree, source, filePath, registry);
    case "python": return detectPython(tree, source, filePath, registry);
    case "typescript":
    case "tsx":
    case "javascript": return detectTypeScript(tree, source, filePath, registry);
    case "java": return detectJava(tree, source, filePath, registry);
    default: return [];
  }
}
```

- [ ] **Step 4: Run test to verify gate checks pass**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts`
Expected: Both gate check tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/rpc-detector.ts tests/indexer/rpc-detector.test.ts
git commit -m "feat: add RPC detector skeleton with import gate checks"
```

---

### Task 5: RPC Detector — Handler and Caller Detection

**Files:**
- Modify: `src/indexer/rpc-detector.ts` — replace all 8 stub functions
- Modify: `tests/indexer/rpc-detector.test.ts` — add handler/caller assertions

- [ ] **Step 1: Add handler and caller tests for all languages**

Append to `tests/indexer/rpc-detector.test.ts`:

```typescript
describe("RPC Detector — Go", () => {
  it("detects handler methods via receiver type ending in Server", async () => {
    const parsed = await parseFile(resolve(FIXTURES, "go-handler.go"));
    const annotations = detectRpcPatterns(parsed!.tree, parsed!.language, parsed!.source, "go-handler.go", registry);
    parsed!.tree.delete();

    const handlers = annotations.filter((a) => a.role === "handler");
    expect(handlers).toHaveLength(2);
    expect(handlers.find((h) => h.methodName === "GetUser")).toBeDefined();
    expect(handlers.find((h) => h.methodName === "CreateUser")).toBeDefined();
    expect(handlers[0].serviceName).toBe("UserService");
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
    expect(callers).toHaveLength(1);
    expect(callers[0].functionName).toBe("loadUser");
    expect(callers[0].serviceName).toBe("UserService");
    expect(callers[0].methodName).toBe("GetUser");
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
```

- [ ] **Step 2: Run tests to verify new assertions fail**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts`
Expected: Gate check tests pass. All new handler/caller tests FAIL (empty arrays).

- [ ] **Step 3: Implement Go handler and caller detection**

Replace the `detectGoHandlers` and `detectGoCalls` stubs in `src/indexer/rpc-detector.ts`:

```typescript
function detectGoHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "method_declaration") {
      const receiver = node.childForFieldName("receiver");
      const methodNameNode = node.childForFieldName("name");
      if (receiver && methodNameNode) {
        const receiverText = getNodeText(receiver, source);
        const methodName = getNodeText(methodNameNode, source);
        for (const svcName of registry.getAllServices()) {
          if (receiverText.includes(svcName) && /Server[)\s,]/.test(receiverText + " ")) {
            const def = registry.lookup(svcName, methodName);
            if (def) {
              out.push({ functionName: methodName, filePath, role: "handler", serviceName: svcName, methodName: def.methodName });
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectGoCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}
```

- [ ] **Step 4: Run Go tests**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts -t "Go"`
Expected: PASS

- [ ] **Step 5: Implement Python handler and caller detection**

```typescript
function detectPythonHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_definition") {
      const argList = node.childForFieldName("superclasses");
      let matchedService: string | null = null;
      if (argList) {
        const baseText = getNodeText(argList, source);
        for (const svcName of registry.getAllServices()) {
          if (baseText.includes(svcName) && baseText.includes("Servicer")) {
            matchedService = svcName;
            break;
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "function_definition") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const def = registry.lookup(matchedService, methodName);
                if (def) {
                  out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectPythonCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}
```

- [ ] **Step 6: Run Python tests**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts -t "Python"`
Expected: PASS

- [ ] **Step 7: Implement TypeScript handler and caller detection**

```typescript
function detectTypeScriptHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      let matchedService: string | null = null;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === "class_heritage") {
          const text = getNodeText(child, source);
          for (const svcName of registry.getAllServices()) {
            if (text.includes(svcName) && text.includes("Server")) {
              matchedService = svcName;
              break;
            }
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "method_definition") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const defs = registry.lookupByMethod(methodName);
                for (const def of defs) {
                  if (def.serviceName === matchedService) {
                    out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectTypeScriptCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkFns(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration" || node.type === "arrow_function" || node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkFns(node.child(i)!);
  }
  walkFns(root);
}
```

- [ ] **Step 8: Run TypeScript tests**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts -t "TypeScript"`
Expected: PASS

- [ ] **Step 9: Implement Java handler and caller detection**

```typescript
function detectJavaHandlers(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      let matchedService: string | null = null;
      const superclass = node.childForFieldName("superclass");
      if (superclass) {
        const superText = getNodeText(superclass, source);
        if (superText.includes("ImplBase")) {
          for (const svcName of registry.getAllServices()) {
            if (superText.includes(svcName)) {
              matchedService = svcName;
              break;
            }
          }
        }
      }
      if (matchedService) {
        const body = node.childForFieldName("body");
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const child = body.child(i)!;
            if (child.type === "method_declaration") {
              const nameNode = child.childForFieldName("name");
              if (nameNode) {
                const methodName = getNodeText(nameNode, source);
                const defs = registry.lookupByMethod(methodName);
                for (const def of defs) {
                  if (def.serviceName === matchedService) {
                    out.push({ functionName: methodName, filePath, role: "handler", serviceName: matchedService, methodName: def.methodName });
                  }
                }
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i)!);
  }
  walk(root);
}

function detectJavaCalls(root: Parser.SyntaxNode, source: string, filePath: string, registry: ProtoRegistry, out: RpcAnnotation[]): void {
  function walkMethods(node: Parser.SyntaxNode): void {
    if (node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) findJavaCallsInBody(node, source, getNodeText(nameNode, source), filePath, registry, out);
      return;
    }
    for (let i = 0; i < node.childCount; i++) walkMethods(node.child(i)!);
  }
  walkMethods(root);
}
```

- [ ] **Step 10: Run all detector tests**

Run: `npx vitest run tests/indexer/rpc-detector.test.ts`
Expected: ALL tests PASS — Go, Python, TypeScript, Java handlers and callers, plus false positive rejection.

- [ ] **Step 11: Commit**

```bash
git add src/indexer/rpc-detector.ts tests/indexer/rpc-detector.test.ts
git commit -m "feat: implement per-language gRPC handler and caller detection"
```

---

### Task 6: Neo4j Queries and RPC Linker

**Files:**
- Modify: `src/db/queries.ts`
- Create: `src/indexer/rpc-linker.ts`

- [ ] **Step 1: Add RPC metadata and linking queries**

Append to `src/db/queries.ts`:

```typescript
export function batchSetRpcHandlerMeta(items: Array<{
  functionName: string;
  filePath: string;
  rpcService: string;
  rpcMethod: string;
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      SET fn.rpcHandlerService = item.rpcService,
          fn.rpcHandlerMethod = item.rpcMethod
    `,
    params: { items },
  };
}

export function batchSetRpcCallerMeta(items: Array<{
  functionName: string;
  filePath: string;
  rpcServices: string[];
  rpcMethods: string[];
}>): CypherQuery {
  return {
    cypher: `
      UNWIND $items AS item
      MATCH (fn:Function {name: item.functionName, filePath: item.filePath})
      SET fn.rpcCallerServices = item.rpcServices,
          fn.rpcCallerMethods = item.rpcMethods
    `,
    params: { items },
  };
}

export function resolveRpcEdges(): CypherQuery {
  return {
    cypher: `
      MATCH (caller:Function)
      WHERE caller.rpcCallerServices IS NOT NULL
      WITH caller, range(0, size(caller.rpcCallerServices) - 1) AS indices
      UNWIND indices AS i
      WITH caller, caller.rpcCallerServices[i] AS svc, caller.rpcCallerMethods[i] AS method
      MATCH (handler:Function {rpcHandlerService: svc, rpcHandlerMethod: method})
      MERGE (caller)-[r:RPC_CALLS]->(handler)
      SET r.serviceName = svc, r.methodName = method
      RETURN count(r) AS edgesCreated
    `,
    params: {},
  };
}
```

- [ ] **Step 2: Create the RPC linker module**

```typescript
// src/indexer/rpc-linker.ts
import type { DbConnection } from "../db/connection.js";
import type { RpcAnnotation } from "./rpc-detector.js";
import {
  batchSetRpcHandlerMeta,
  batchSetRpcCallerMeta,
  resolveRpcEdges,
} from "../db/queries.js";

export async function linkRpcEdges(
  db: DbConnection,
  annotations: RpcAnnotation[]
): Promise<number> {
  if (annotations.length === 0) return 0;

  const session = db.session();
  try {
    const handlers = annotations.filter((a) => a.role === "handler");
    const callers = annotations.filter((a) => a.role === "caller");

    if (handlers.length > 0) {
      const handlerItems = handlers.map((h) => ({
        functionName: h.functionName,
        filePath: h.filePath,
        rpcService: h.serviceName,
        rpcMethod: h.methodName,
      }));
      const q = batchSetRpcHandlerMeta(handlerItems);
      await session.run(q.cypher, q.params);
    }

    if (callers.length > 0) {
      const callerMap = new Map<string, { services: string[]; methods: string[] }>();
      for (const c of callers) {
        const key = `${c.filePath}::${c.functionName}`;
        if (!callerMap.has(key)) {
          callerMap.set(key, { services: [], methods: [] });
        }
        const entry = callerMap.get(key)!;
        entry.services.push(c.serviceName);
        entry.methods.push(c.methodName);
      }

      const callerItems = [...callerMap.entries()].map(([key, val]) => {
        const sepIdx = key.indexOf("::");
        return {
          functionName: key.slice(sepIdx + 2),
          filePath: key.slice(0, sepIdx),
          rpcServices: val.services,
          rpcMethods: val.methods,
        };
      });
      const q = batchSetRpcCallerMeta(callerItems);
      await session.run(q.cypher, q.params);
    }

    const resolveQ = resolveRpcEdges();
    const result = await session.run(resolveQ.cypher, resolveQ.params);
    const raw = result.records[0]?.get("edgesCreated");
    return typeof raw?.toNumber === "function" ? raw.toNumber() : (raw ?? 0);
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/db/queries.ts src/indexer/rpc-linker.ts
git commit -m "feat: add Neo4j RPC metadata queries and linker module"
```

---

### Task 7: Pipeline Integration

**Files:**
- Modify: `src/indexer/parser.ts`
- Modify: `src/indexer/parallel-pipeline.ts`
- Modify: `src/indexer/index.ts`

- [ ] **Step 1: Add .proto to the parser extension map**

In `src/indexer/parser.ts`, add to `EXTENSION_MAP` after `".bash": "bash"`:

```typescript
  ".proto": "proto",
```

- [ ] **Step 2: Update parallel-pipeline.ts**

Add import at top:

```typescript
import type { RpcAnnotation } from "./rpc-detector.js";
```

Add `rpcDetectFn` to `PipelineOptions`:

```typescript
  rpcDetectFn?: (tree: any, language: string, source: string, filePath: string) => RpcAnnotation[];
```

Add `rpcAnnotations` to `PipelineResult`:

```typescript
  rpcAnnotations: RpcAnnotation[];
```

Initialize in `runParallelPipeline`:

```typescript
const result: PipelineResult = { filesIndexed: 0, functionsFound: 0, classesFound: 0, errors: [], rpcAnnotations: [] };
```

Destructure `rpcDetectFn` from options alongside the existing destructuring.

In the task function, inside the `try` block after `extractFn` and before `tree.delete()`:

```typescript
          if (rpcDetectFn) {
            const rpcAnns = rpcDetectFn(parseResult.tree, parseResult.language, parseResult.source, file);
            if (rpcAnns.length > 0) {
              result.rpcAnnotations.push(...rpcAnns);
            }
          }
```

- [ ] **Step 3: Update index.ts**

Add imports at top of `src/indexer/index.ts`:

```typescript
import { createProtoRegistry, type ProtoRegistry } from "./proto-registry.js";
import { parseProtoFiles } from "./proto-parser.js";
import { detectRpcPatterns, type RpcAnnotation } from "./rpc-detector.js";
import { linkRpcEdges } from "./rpc-linker.js";
```

Add re-exports for external consumers:

```typescript
export { createProtoRegistry, type ProtoRegistry } from "./proto-registry.js";
```

Add `protoRegistry` to options and `rpcEdgesCreated` to `IndexResult`:

```typescript
  options: {
    changedOnly?: boolean;
    specificPath?: string;
    concurrency?: number;
    maxMemoryMB?: number;
    protoRegistry?: ProtoRegistry;
    onProgress?: (current: number, total: number, file: string) => void;
    onFlushProgress?: (completed: number, total: number) => void;
  } = {}
```

```typescript
  const result: IndexResult = {
    filesIndexed: 0,
    functionsFound: 0,
    classesFound: 0,
    orphansRemoved: 0,
    rpcEdgesCreated: 0,
    errors: [],
  };
```

After `files = files.filter((f) => detectLanguage(f) !== null);`, add proto separation:

```typescript
  // Separate proto files for pre-processing (before staleness filtering)
  const protoFiles = files.filter((f) => f.endsWith(".proto"));
  files = files.filter((f) => !f.endsWith(".proto"));

  // Parse proto files into registry (always, even for changedOnly)
  const registry = options.protoRegistry ?? createProtoRegistry();
  if (protoFiles.length > 0) {
    parseProtoFiles(protoFiles, registry);
  }

  // Create RPC detect function if registry has services
  const rpcDetectFn = registry.getAllServices().length > 0
    ? (tree: any, language: string, source: string, filePath: string) =>
        detectRpcPatterns(tree, language, source, filePath, registry)
    : undefined;
```

Declare a shared annotation collector before the concurrency branch:

```typescript
  let allRpcAnnotations: RpcAnnotation[] = [];
```

In the concurrent branch, pass `rpcDetectFn` and collect annotations:

```typescript
    const pipelineResult = await runParallelPipeline({
      files,
      absRoot,
      concurrency,
      maxMemoryBytes,
      parseFn: parseFile,
      extractFn: extractGraphEntities,
      rpcDetectFn,
      batchWriter,
      computeHashFn: computeFileHash,
      getMtimeFn: getFileMtime,
      onProgress: options.onProgress,
      onFlushProgress: options.onFlushProgress,
    });
    result.filesIndexed = pipelineResult.filesIndexed;
    result.functionsFound = pipelineResult.functionsFound;
    result.classesFound = pipelineResult.classesFound;
    result.errors = pipelineResult.errors;
    allRpcAnnotations = pipelineResult.rpcAnnotations;
```

In the sequential branch, add RPC detection inside the per-file loop after extraction (before `tree.delete()`):

```typescript
        let fileRpcAnnotations: RpcAnnotation[] = [];
        try {
          entities = extractGraphEntities(parseResult.tree, parseResult.language, parseResult.source, file);
          if (rpcDetectFn) {
            fileRpcAnnotations = rpcDetectFn(parseResult.tree, parseResult.language, parseResult.source, file);
          }
        } finally {
          parseResult.tree.delete();
        }
        // ... existing batchWriter.add and counters ...
        allRpcAnnotations.push(...fileRpcAnnotations);
```

After both pipeline branches (after `batchWriter.flush()` completes), add the linking step before orphan cleanup:

```typescript
  // Link RPC edges from annotations
  if (allRpcAnnotations.length > 0) {
    result.rpcEdgesCreated = await linkRpcEdges(db, allRpcAnnotations);
  }
```

- [ ] **Step 4: Build and verify no type errors**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests pass (new fields are additive).

- [ ] **Step 6: Commit**

```bash
git add src/indexer/parser.ts src/indexer/parallel-pipeline.ts src/indexer/index.ts
git commit -m "feat: integrate proto parsing, RPC detection, and linking into indexing pipeline"
```

---

### Task 8: Integration Tests — Monorepo

**Files:**
- Create: `tests/fixtures/grpc/monorepo/` fixture files
- Modify: `tests/integration/microservices.test.ts`

- [ ] **Step 1: Create monorepo fixture files**

Create `tests/fixtures/grpc/monorepo/proto/user.proto`:

```protobuf
syntax = "proto3";
package user.v1;

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
}

message GetUserRequest { string id = 1; }
message GetUserResponse { string id = 1; string name = 2; }
message CreateUserRequest { string name = 1; }
message CreateUserResponse { string id = 1; }
```

Create `tests/fixtures/grpc/monorepo/user-service/src/handler.go`:

```go
package main

import (
	"context"
	pb "myproject/proto/user/v1"
)

type UserServiceServer struct {
	pb.UnimplementedUserServiceServer
}

func (s *UserServiceServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
	return &pb.GetUserResponse{Id: req.Id, Name: "Alice"}, nil
}

func (s *UserServiceServer) CreateUser(ctx context.Context, req *pb.CreateUserRequest) (*pb.CreateUserResponse, error) {
	return &pb.CreateUserResponse{Id: "new-id"}, nil
}
```

Create `tests/fixtures/grpc/monorepo/auth-service/src/caller.py`:

```python
import grpc
import user_pb2
import user_pb2_grpc

def fetchUser(channel, user_id):
    stub = user_pb2_grpc.UserServiceStub(channel)
    response = stub.GetUser(user_pb2.GetUserRequest(id=user_id))
    return response.name
```

Create `tests/fixtures/grpc/monorepo/auth-service/src/not-grpc.py`:

```python
def GetUser(user_id):
    """A local helper that happens to share a name with the RPC."""
    return {"id": user_id, "name": "local"}
```

- [ ] **Step 2: Add monorepo integration test**

Append to `tests/integration/microservices.test.ts`, adding the import:

```typescript
import { createProtoRegistry } from "../../src/indexer/index.js";
```

Then the test suite:

```typescript
describe.skipIf(!INTEGRATION)("gRPC monorepo integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("creates RPC_CALLS edges in a single indexRepository call", async () => {
    const monoRoot = resolve("tests/fixtures/grpc/monorepo");
    const result = await indexRepository(db, monoRoot, {
      ...DEFAULT_CONFIG.index,
      include: ["**/*"],
    });

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'monorepo'
        RETURN caller.name AS callerName, handler.name AS handlerName,
               r.serviceName AS serviceName, r.methodName AS methodName
      `);
      const edges = res.records.map((r) => ({
        callerName: r.get("callerName"),
        handlerName: r.get("handlerName"),
        serviceName: r.get("serviceName"),
        methodName: r.get("methodName"),
      }));

      const getUserEdge = edges.find((e) => e.callerName === "fetchUser" && e.handlerName === "GetUser");
      expect(getUserEdge).toBeDefined();
      expect(getUserEdge!.serviceName).toBe("UserService");
    } finally {
      await session.close();
    }
  });

  it("does not create RPC_CALLS for non-gRPC functions with matching names", async () => {
    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (fn:Function {name: "GetUser"})
        WHERE fn.filePath CONTAINS "not-grpc"
        OPTIONAL MATCH (fn)-[r:RPC_CALLS]-()
        RETURN count(r) AS rpcEdges
      `);
      expect(res.records[0].get("rpcEdges").toNumber()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
```

- [ ] **Step 3: Run monorepo integration test**

Run: `INTEGRATION=1 npx vitest run tests/integration/microservices.test.ts -t "gRPC monorepo"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/grpc/monorepo/ tests/integration/microservices.test.ts
git commit -m "test: add monorepo gRPC integration tests"
```

---

### Task 9: Integration Tests — Multirepo

**Files:**
- Create: `tests/fixtures/grpc/multirepo/` fixture files
- Modify: `tests/integration/microservices.test.ts`

- [ ] **Step 1: Create multirepo fixture files**

Create `tests/fixtures/grpc/multirepo/proto-repo/user/v1/user.proto`:

```protobuf
syntax = "proto3";
package user.v1;

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc CreateUser (CreateUserRequest) returns (CreateUserResponse);
}

message GetUserRequest { string id = 1; }
message GetUserResponse { string id = 1; string name = 2; }
message CreateUserRequest { string name = 1; }
message CreateUserResponse { string id = 1; }
```

Create `tests/fixtures/grpc/multirepo/service-a/src/caller.ts`:

```typescript
import { UserServiceClient } from "./generated/user_grpc_pb";

async function loadUser(client: UserServiceClient, userId: string) {
  const response = await client.getUser({ id: userId });
  return response.name;
}
```

Create `tests/fixtures/grpc/multirepo/service-b/src/handler.java`:

```java
package com.example.userservice;

import com.example.proto.UserServiceGrpc;
import com.example.proto.User.GetUserRequest;
import com.example.proto.User.GetUserResponse;
import com.example.proto.User.CreateUserRequest;
import com.example.proto.User.CreateUserResponse;

public class UserServiceImpl extends UserServiceGrpc.UserServiceImplBase {
    @Override
    public GetUserResponse getUser(GetUserRequest request) {
        return GetUserResponse.newBuilder()
            .setId(request.getId())
            .setName("Alice")
            .build();
    }

    @Override
    public CreateUserResponse createUser(CreateUserRequest request) {
        return CreateUserResponse.newBuilder()
            .setId("new-id")
            .build();
    }
}
```

- [ ] **Step 2: Add multirepo integration tests**

Append to `tests/integration/microservices.test.ts`:

```typescript
describe.skipIf(!INTEGRATION)("gRPC multirepo integration", () => {
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    db = createConnection({
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "code-graph-rag",
    });
    await setupSchema(db);
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it("resolves cross-repo RPC_CALLS with shared ProtoRegistry", async () => {
    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    const result = await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-b"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN caller.name AS callerName, handler.name AS handlerName,
               r.serviceName AS serviceName, r.methodName AS methodName
      `);
      expect(res.records.length).toBeGreaterThan(0);
      expect(res.records[0].get("callerName")).toBe("loadUser");
      expect(res.records[0].get("handlerName")).toBe("getUser");
      expect(res.records[0].get("serviceName")).toBe("UserService");
    } finally {
      await session.close();
    }
  });

  it("resolves edges regardless of service indexing order", async () => {
    const session = db.session();
    try {
      await session.run("MATCH (n) WHERE n.filePath CONTAINS 'multirepo' DETACH DELETE n");
    } finally {
      await session.close();
    }

    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    // Index handler FIRST, then caller
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-b"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    const result = await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    expect(result.rpcEdgesCreated).toBeGreaterThan(0);

    const session2 = db.session();
    try {
      const res = await session2.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session2.close();
    }
  });

  it("preserves cross-repo edges when re-indexing a single service", async () => {
    const registry = createProtoRegistry();

    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/proto-repo"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );
    await indexRepository(
      db,
      resolve("tests/fixtures/grpc/multirepo/service-a"),
      { ...DEFAULT_CONFIG.index, include: ["**/*"] },
      { protoRegistry: registry }
    );

    const session = db.session();
    try {
      const res = await session.run(`
        MATCH (caller:Function)-[r:RPC_CALLS]->(handler:Function)
        WHERE caller.filePath CONTAINS 'service-a'
          AND handler.filePath CONTAINS 'service-b'
        RETURN count(r) AS count
      `);
      expect(res.records[0].get("count").toNumber()).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
```

- [ ] **Step 3: Run multirepo integration tests**

Run: `INTEGRATION=1 npx vitest run tests/integration/microservices.test.ts -t "gRPC multirepo"`
Expected: PASS

- [ ] **Step 4: Run ALL tests for final verification**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All unit tests pass. No type errors.

Run: `INTEGRATION=1 npx vitest run`
Expected: All integration tests pass (requires Neo4j running).

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/grpc/multirepo/ tests/integration/microservices.test.ts
git commit -m "test: add multirepo gRPC integration tests with cross-repo RPC_CALLS edges"
```

---

## Verification Checklist

After all tasks, confirm:

- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npx vitest run` — all unit tests pass
- [ ] `INTEGRATION=1 npx vitest run` — all integration tests pass (requires Neo4j)
- [ ] Monorepo: single `indexRepository` call creates `RPC_CALLS` edges across services
- [ ] Multirepo: shared `ProtoRegistry` across `indexRepository` calls resolves cross-repo edges
- [ ] Multirepo: indexing order does not matter — last repo resolves all edges
- [ ] Multirepo: re-indexing single service preserves cross-repo edges
- [ ] False positives: non-gRPC functions with matching names get no `RPC_CALLS` edges
- [ ] All 4 languages tested: Go handler, Python caller (monorepo), Java handler, TypeScript caller (multirepo)
