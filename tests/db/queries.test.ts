// tests/db/queries.test.ts
import { describe, it, expect } from "vitest";
import {
  upsertRepository,
  upsertFile,
  upsertFunction,
  upsertClass,
  upsertCallRelationship,
  upsertImportRelationship,
  deleteFileAndRelationships,
  upsertRepositoryWithCommit,
  getRepositoryCommit,
  deleteRepositoryAndFiles,
} from "../../src/db/queries.js";

describe("query builders", () => {
  it("upsertRepository returns valid cypher and params", () => {
    const { cypher, params } = upsertRepository({
      path: "/home/user/project",
      name: "project",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Repository");
    expect(params.path).toBe("/home/user/project");
    expect(params.name).toBe("project");
  });

  it("upsertFile returns valid cypher and params", () => {
    const { cypher, params } = upsertFile({
      path: "/home/user/project/src/index.ts",
      relativePath: "src/index.ts",
      repoPath: "/home/user/project",
      language: "typescript",
      hash: "abc123",
      lastModified: 1700000000,
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":File");
    expect(cypher).toContain("CONTAINS_FILE");
    expect(params.path).toBe("/home/user/project/src/index.ts");
  });

  it("upsertFunction returns valid cypher and params", () => {
    const { cypher, params } = upsertFunction({
      name: "greet",
      filePath: "/home/user/project/src/index.ts",
      startLine: 1,
      endLine: 5,
      signature: "function greet(name: string): string",
      docstring: null,
      snippet: "function greet(name: string): string {\n  return `Hello ${name}`;\n}",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Function");
    expect(cypher).toContain("CONTAINS");
    expect(params.name).toBe("greet");
  });

  it("upsertClass returns valid cypher and params", () => {
    const { cypher, params } = upsertClass({
      name: "UserService",
      filePath: "/home/user/project/src/user.ts",
      startLine: 1,
      endLine: 20,
      docstring: "Handles user operations",
    });
    expect(cypher).toContain("MERGE");
    expect(cypher).toContain(":Class");
    expect(params.name).toBe("UserService");
  });

  it("upsertCallRelationship returns valid cypher", () => {
    const { cypher, params } = upsertCallRelationship({
      callerName: "handleRequest",
      callerFilePath: "/home/user/project/src/router.ts",
      calleeName: "validateToken",
    });
    expect(cypher).toContain("CALLS");
    expect(params.callerName).toBe("handleRequest");
    expect(params.calleeName).toBe("validateToken");
  });

  it("upsertImportRelationship returns valid cypher", () => {
    const { cypher, params } = upsertImportRelationship({
      sourceFilePath: "/home/user/project/src/router.ts",
      targetFilePath: "/home/user/project/src/auth.ts",
    });
    expect(cypher).toContain("IMPORTS");
    expect(params.sourceFilePath).toBe("/home/user/project/src/router.ts");
  });

  it("deleteFileAndRelationships returns valid cypher", () => {
    const { cypher, params } = deleteFileAndRelationships({
      filePath: "/home/user/project/src/old.ts",
    });
    expect(cypher).toContain("DETACH DELETE");
    expect(params.filePath).toBe("/home/user/project/src/old.ts");
  });

  it("upsertRepositoryWithCommit includes lastIndexedCommit", () => {
    const { cypher, params } = upsertRepositoryWithCommit({
      path: "/project",
      name: "project",
      lastIndexedCommit: "abc123def",
    });
    expect(cypher).toContain("lastIndexedCommit");
    expect(params.lastIndexedCommit).toBe("abc123def");
  });

  it("getRepositoryCommit returns query for lastIndexedCommit", () => {
    const { cypher, params } = getRepositoryCommit({ path: "/project" });
    expect(cypher).toContain("lastIndexedCommit");
    expect(params.path).toBe("/project");
  });
});

describe("deleteRepositoryAndFiles", () => {
  it("returns a query scoped to the given repo path", () => {
    const q = deleteRepositoryAndFiles({ repoPath: "/abs/root/svc-a" });
    expect(q.cypher).toContain("STARTS WITH $repoPath");
    expect(q.cypher).toContain("DETACH DELETE");
    expect(q.params).toEqual({ repoPath: "/abs/root/svc-a" });
  });
});
