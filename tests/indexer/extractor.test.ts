// tests/indexer/extractor.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { initParser, parseFile } from "../../src/indexer/parser.js";
import { extractGraphEntities, type GraphEntities } from "../../src/indexer/extractor.js";

describe("extractGraphEntities", () => {
  beforeAll(async () => {
    await initParser();
  });

  describe("TypeScript extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.ts");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.ts"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("greet");
      expect(funcNames).toContain("validateEmail");
    });

    it("extracts classes", () => {
      const classNames = entities.classes.map((c) => c.name);
      expect(classNames).toContain("UserService");
    });

    it("extracts methods inside classes", () => {
      const methods = entities.functions.filter(
        (f) => f.className === "UserService"
      );
      const methodNames = methods.map((m) => m.name);
      expect(methodNames).toContain("createUser");
      expect(methodNames).toContain("getUser");
    });

    it("extracts function signatures", () => {
      const greet = entities.functions.find((f) => f.name === "greet");
      expect(greet!.signature).toContain("greet");
    });

    it("extracts code snippets", () => {
      const greet = entities.functions.find((f) => f.name === "greet");
      expect(greet!.snippet).toContain("Hello");
    });

    it("extracts call relationships", () => {
      const calls = entities.calls;
      const callNames = calls.map((c) => ({
        caller: c.callerName,
        callee: c.calleeName,
      }));
      expect(callNames).toContainEqual({
        caller: "createUser",
        callee: "validateEmail",
      });
    });

    it("extracts GraphQL resolver functions from object property arrows", async () => {
      const result = await parseFile("tests/fixtures/grpc/ts-graphql-resolver.ts");
      const resolverEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/grpc/ts-graphql-resolver.ts"
      );
      result!.tree.delete();

      const userResolver = resolverEntities.functions.find((f) => f.name === "user");
      expect(userResolver).toBeDefined();
      expect(resolverEntities.calls).toContainEqual(
        expect.objectContaining({ callerName: "user", calleeName: "getUser" })
      );
    });
  });

  describe("Python extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.py");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.py"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("greet");
      expect(funcNames).toContain("validate_email");
    });

    it("extracts classes", () => {
      const classNames = entities.classes.map((c) => c.name);
      expect(classNames).toContain("UserService");
    });

    it("extracts imports", () => {
      expect(entities.imports.length).toBeGreaterThan(0);
    });
  });

  describe("Go extraction", () => {
    let entities: GraphEntities;

    beforeAll(async () => {
      const result = await parseFile("tests/fixtures/sample.go");
      entities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/sample.go"
      );
    });

    it("extracts functions", () => {
      const funcNames = entities.functions.map((f) => f.name);
      expect(funcNames).toContain("Greet");
      expect(funcNames).toContain("ValidateEmail");
    });
  });
});
