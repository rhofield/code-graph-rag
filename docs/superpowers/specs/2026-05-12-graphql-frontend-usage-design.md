# GraphQL Frontend Usage Detection Design

## Goal

Detect GraphQL queries, mutations, subscriptions, and fragments used from frontend `.ts` and `.tsx` files, including usage through fragment spreads and imported `.graphql` / `.gql` documents.

## Scope

The indexer will create first-class `GraphQLDocument` graph nodes for named operations and fragments. Frontend functions and components will link to the documents they pass to common GraphQL APIs. GraphQL documents will also link to fragments they spread, including nested fragment spreads.

## Extraction

The extractor will recognize GraphQL documents in three places:

- Standalone `.graphql` and `.gql` files.
- `gql` and `graphql` tagged template literals in `.ts` and `.tsx` files.
- GraphQL files imported by `.ts` and `.tsx` files.

The detector will parse the document text for operation definitions, fragment definitions, and named fragment spreads. It will keep this parser small and dependency-free because the indexer does not currently depend on the `graphql` package.

## Graph Shape

- `(doc:GraphQLDocument)` with `name`, `kind`, `filePath`, line numbers, signature, snippet, and optional frontend variable name.
- `(function:Function)-[:USES_GRAPHQL]->(doc:GraphQLDocument)` when a frontend function or component passes a GraphQL document variable to APIs such as `useQuery`, `useMutation`, `useSubscription`, `useFragment`, `readFragment`, or client query/mutation calls.
- `(doc:GraphQLDocument)-[:USES_FRAGMENT]->(fragment:GraphQLDocument)` when an operation or fragment spreads another fragment.

Fragment usage is transitive through the graph: a component using `GetUser` depends on `UserFields` if `GetUser` spreads `UserFields`, even when the component never references `UserFields` directly.

## Testing

Tests will cover inline TSX queries, inline TS mutations, standalone GraphQL files, imported GraphQL documents, direct fragment spreads, nested fragment spreads, and graph writer/query-builder output for the new nodes and relationships.
