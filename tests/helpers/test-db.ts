import { createConnection } from "../../src/db/connection.js";

// Connects to the dedicated ephemeral test instance (docker compose --profile
// test up -d), NOT the live dev graph on 7687. Integration tests create and
// destroy fixture data freely; pointing them at the dev graph causes both
// pollution and false failures from name collisions with indexed repos.
export const TEST_NEO4J_CONFIG = {
  uri: process.env.NEO4J_TEST_URI ?? "bolt://localhost:7688",
  username: process.env.NEO4J_TEST_USERNAME ?? "neo4j",
  password: process.env.NEO4J_TEST_PASSWORD ?? "code-graph-rag",
};

export function createTestConnection(): ReturnType<typeof createConnection> {
  return createConnection(TEST_NEO4J_CONFIG);
}
