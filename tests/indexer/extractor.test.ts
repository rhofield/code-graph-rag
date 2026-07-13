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

    it("extracts frontend GraphQL documents, usages, and fragment spreads from TSX", async () => {
      const result = await parseFile("tests/fixtures/graphql/frontend-graphql.tsx");
      const frontendEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/graphql/frontend-graphql.tsx"
      );
      result!.tree.delete();

      expect(frontendEntities.graphqlDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "GetUser",
            kind: "query",
            variableName: "GET_USER",
            resolverFieldNames: ["user"],
          }),
          expect.objectContaining({
            name: "UpdateUser",
            kind: "mutation",
            variableName: "UPDATE_USER",
            resolverFieldNames: ["updateUser"],
          }),
          expect.objectContaining({
            name: "UserFields",
            kind: "fragment",
            variableName: "USER_FIELDS",
          }),
          expect.objectContaining({
            name: "AvatarFields",
            kind: "fragment",
            variableName: "AVATAR_FIELDS",
          }),
          expect.objectContaining({
            name: "GetImportedUser",
            kind: "query",
            resolverFieldNames: ["user"],
            filePath: expect.stringContaining("tests/fixtures/graphql/UserFields.graphql"),
          }),
          expect.objectContaining({
            name: "InlineApolloUser",
            kind: "query",
            variableName: expect.stringMatching(/^__inline_graphql_/),
            resolverFieldNames: ["user"],
          }),
          expect.objectContaining({
            name: "GetApolloUser",
            kind: "query",
            variableName: "GET_APOLLO_USER",
            resolverFieldNames: ["user"],
            filePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
          expect.objectContaining({
            name: "UpdateApolloUser",
            kind: "mutation",
            variableName: "UPDATE_APOLLO_USER",
            resolverFieldNames: ["updateUser"],
            filePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
        ])
      );

      expect(frontendEntities.graphqlUsages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceName: "UserCard",
            documentName: "GetUser",
          }),
          expect.objectContaining({
            sourceName: "ImportedUserCard",
            documentName: "GetImportedUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/UserFields.graphql"),
          }),
          expect.objectContaining({
            sourceName: "RenameUser",
            documentName: "UpdateUser",
          }),
          expect.objectContaining({
            sourceName: "InlineApolloUserCard",
            documentName: "InlineApolloUser",
          }),
          expect.objectContaining({
            sourceName: "ImportedApolloUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
          expect.objectContaining({
            sourceName: "ImportedApolloRename",
            documentName: "UpdateApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
          expect.objectContaining({
            sourceName: "BarrelApolloUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
          expect.objectContaining({
            sourceName: "GeneratedApolloUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-documents.ts"),
          }),
        ])
      );

      expect(frontendEntities.graphqlFragmentSpreads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceDocumentName: "GetUser",
            targetFragmentName: "UserFields",
          }),
          expect.objectContaining({
            sourceDocumentName: "UserFields",
            targetFragmentName: "AvatarFields",
          }),
          expect.objectContaining({
            sourceDocumentName: "GetImportedUser",
            targetFragmentName: "UserFields",
            sourceDocumentFilePath: expect.stringContaining("tests/fixtures/graphql/UserFields.graphql"),
            targetFragmentFilePath: expect.stringContaining("tests/fixtures/graphql/UserFields.graphql"),
          }),
        ])
      );
    });

    it("extracts Apollo resolver object method, function-expression, and alias syntax", async () => {
      const result = await parseFile("tests/fixtures/graphql/apollo-resolver-syntax.ts");
      const resolverEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/graphql/apollo-resolver-syntax.ts"
      );
      result!.tree.delete();

      expect(resolverEntities.functions.map((f) => f.name)).toEqual(
        expect.arrayContaining(["user", "viewer", "me", "getUserResolver"])
      );
      expect(resolverEntities.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callerName: "user", calleeName: "getUser" }),
          expect.objectContaining({ callerName: "viewer", calleeName: "getUser" }),
          expect.objectContaining({ callerName: "me", calleeName: "getUserResolver" }),
        ])
      );
    });

    it("does not extract arbitrary object aliases as resolver functions", async () => {
      const result = await parseFile("tests/fixtures/graphql/non-resolver-aliases.ts");
      const aliasEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/graphql/non-resolver-aliases.ts"
      );
      result!.tree.delete();

      const aliases = aliasEntities.functions.filter((f) => f.name === "user");
      expect(aliases).toEqual([]);
      expect(aliasEntities.calls).not.toContainEqual(
        expect.objectContaining({ callerName: "user", calleeName: "UserPage" })
      );
      expect(aliasEntities.calls).not.toContainEqual(
        expect.objectContaining({ callerName: "user", calleeName: "currentUser" })
      );
    });

    it("links generated Apollo hooks imported without document constants", async () => {
      const result = await parseFile("tests/fixtures/graphql/generated-hook-usage.tsx");
      const hookEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/graphql/generated-hook-usage.tsx"
      );
      result!.tree.delete();

      expect(hookEntities.graphqlDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "GetApolloUser",
            kind: "query",
            variableName: "GET_APOLLO_USER",
            resolverFieldNames: ["user"],
            filePath: expect.stringContaining("tests/fixtures/graphql/apollo-generated-hooks.ts"),
          }),
        ])
      );
      expect(hookEntities.graphqlUsages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceName: "ImportedGeneratedApolloUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-generated-hooks.ts"),
          }),
          expect.objectContaining({
            sourceName: "ImportedGeneratedApolloLazyUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-generated-hooks.ts"),
          }),
          expect.objectContaining({
            sourceName: "ImportedGeneratedApolloSuspenseUserCard",
            documentName: "GetApolloUser",
            documentFilePath: expect.stringContaining("tests/fixtures/graphql/apollo-generated-hooks.ts"),
          }),
        ])
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

  describe("GraphQL extraction", () => {
    it("extracts standalone GraphQL operations, fragments, and nested fragment spreads", async () => {
      const result = await parseFile("tests/fixtures/graphql/UserFields.graphql");
      const graphqlEntities = extractGraphEntities(
        result!.tree,
        result!.language,
        result!.source,
        "tests/fixtures/graphql/UserFields.graphql"
      );
      result!.tree.delete();

      expect(graphqlEntities.graphqlDocuments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "GetImportedUser", kind: "query" }),
          expect.objectContaining({ name: "UserFields", kind: "fragment" }),
          expect.objectContaining({ name: "AvatarFields", kind: "fragment" }),
        ])
      );
      expect(graphqlEntities.graphqlFragmentSpreads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceDocumentName: "GetImportedUser",
            targetFragmentName: "UserFields",
          }),
          expect.objectContaining({
            sourceDocumentName: "UserFields",
            targetFragmentName: "AvatarFields",
          }),
        ])
      );
    });
  });
});
