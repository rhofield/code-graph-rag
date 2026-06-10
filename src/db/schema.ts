import type { DbConnection } from "./connection.js";

export async function setupSchema(db: DbConnection): Promise<void> {
  const session = db.session();
  try {
    // Uniqueness constraints
    await session.run(
      "CREATE CONSTRAINT repo_path IF NOT EXISTS FOR (r:Repository) REQUIRE r.path IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT file_path IF NOT EXISTS FOR (f:File) REQUIRE f.path IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT proto_method_key IF NOT EXISTS FOR (m:ProtoMethod) REQUIRE (m.serviceName, m.methodName) IS UNIQUE"
    );
    await session.run(
      "CREATE CONSTRAINT proto_message_key IF NOT EXISTS FOR (m:ProtoMessage) REQUIRE (m.messageName, m.packageName) IS UNIQUE"
    );

    // Indexes for fast lookup
    await session.run(
      "CREATE INDEX function_name IF NOT EXISTS FOR (f:Function) ON (f.name)"
    );
    await session.run(
      "CREATE INDEX class_name IF NOT EXISTS FOR (c:Class) ON (c.name)"
    );
    await session.run(
      "CREATE INDEX file_language IF NOT EXISTS FOR (f:File) ON (f.language)"
    );
    await session.run(
      "CREATE INDEX function_rpc_handler IF NOT EXISTS FOR (f:Function) ON (f.rpcHandlerService, f.rpcHandlerMethod)"
    );

    // Full-text index for search_code
    await session.run(`
      CREATE FULLTEXT INDEX code_search IF NOT EXISTS
      FOR (n:Function|Class)
      ON EACH [n.name, n.snippet, n.docstring]
    `);
  } finally {
    await session.close();
  }
}
