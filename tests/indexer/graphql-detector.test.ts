import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractGraphQLArtifactsFromTypeScript,
  extractGraphQLUsagesFromFunction,
} from "../../src/indexer/graphql-detector.js";

describe("GraphQL detector", () => {
  it("binds gql variables to the operation when colocated fragments appear first", () => {
    const filePath = "/repo/UserCard.tsx";
    const artifacts = extractGraphQLArtifactsFromTypeScript(
      `
        import { gql, useQuery } from "@apollo/client";

        const GET_USER = gql\`
          fragment UserFields on User {
            id
          }

          query GetUser($id: ID!) {
            user(id: $id) {
              ...UserFields
            }
          }
        \`;

        export function UserCard({ id }: { id: string }) {
          return useQuery(GET_USER, { variables: { id } });
        }
      `,
      filePath
    );

    const usages = extractGraphQLUsagesFromFunction(
      "function UserCard() { return useQuery(GET_USER); }",
      "UserCard",
      filePath,
      artifacts.documentVariables,
      artifacts.documents
    );

    expect(artifacts.documentVariables.get("GET_USER")).toEqual(
      expect.objectContaining({ name: "GetUser", kind: "query" })
    );
    expect(usages).toEqual([
      expect.objectContaining({
        sourceName: "UserCard",
        documentName: "GetUser",
        documentFilePath: filePath,
      }),
    ]);
  });

  it("resolves fragment spread targets to imported gql fragment files", () => {
    const dir = mkdtempSync(join(tmpdir(), "rho-graphql-"));
    const fragmentsPath = join(dir, "fragments.ts");
    const componentPath = join(dir, "component.tsx");
    writeFileSync(
      fragmentsPath,
      `
        import { gql } from "@apollo/client";

        export const USER_FIELDS = gql\`
          fragment UserFields on User {
            id
            name
          }
        \`;
      `
    );

    const artifacts = extractGraphQLArtifactsFromTypeScript(
      `
        import { gql } from "@apollo/client";
        import { USER_FIELDS } from "./fragments";

        const GET_USER = gql\`
          \${USER_FIELDS}
          query GetUser($id: ID!) {
            user(id: $id) {
              ...UserFields
            }
          }
        \`;
      `,
      componentPath
    );

    expect(artifacts.fragmentSpreads).toContainEqual({
      sourceDocumentName: "GetUser",
      sourceDocumentFilePath: componentPath,
      targetFragmentName: "UserFields",
      targetFragmentFilePath: fragmentsPath,
    });
  });

  it("deduplicates documents reached through multiple import paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "rho-graphql-"));
    const documentsPath = join(dir, "documents.ts");
    const barrelAPath = join(dir, "barrel-a.ts");
    const barrelBPath = join(dir, "barrel-b.ts");
    const componentPath = join(dir, "component.tsx");

    writeFileSync(
      documentsPath,
      `
        import { gql } from "@apollo/client";

        export const USER_FIELDS = gql\`
          fragment UserFields on User {
            id
          }
        \`;
      `
    );
    writeFileSync(barrelAPath, `export { USER_FIELDS } from "./documents";`);
    writeFileSync(barrelBPath, `export { USER_FIELDS } from "./documents";`);

    const artifacts = extractGraphQLArtifactsFromTypeScript(
      `
        import { gql } from "@apollo/client";
        import { USER_FIELDS as USER_FIELDS_A } from "./barrel-a";
        import { USER_FIELDS as USER_FIELDS_B } from "./barrel-b";

        const GET_USER = gql\`
          \${USER_FIELDS_A}
          \${USER_FIELDS_B}
          query GetUser($id: ID!) {
            user(id: $id) {
              ...UserFields
            }
          }
        \`;
      `,
      componentPath
    );

    expect(
      artifacts.documents.filter(
        (doc) => doc.name === "UserFields" && doc.filePath === documentsPath
      )
    ).toHaveLength(1);
    expect(artifacts.documentVariables.get("USER_FIELDS_A")).toEqual(
      expect.objectContaining({ name: "UserFields", filePath: documentsPath })
    );
    expect(artifacts.documentVariables.get("USER_FIELDS_B")).toEqual(
      expect.objectContaining({ name: "UserFields", filePath: documentsPath })
    );
  });
});
