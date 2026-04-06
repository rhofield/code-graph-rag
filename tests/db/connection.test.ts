import { describe, it, expect } from "vitest";
import { createConnection } from "../../src/db/connection.js";

describe("createConnection", () => {
  it("creates a connection with the provided config", () => {
    const conn = createConnection({
      uri: "bolt://localhost:7687",
      username: "neo4j",
      password: "code-graph-rag",
    });
    expect(conn).toBeDefined();
    expect(conn.driver).toBeDefined();
    expect(typeof conn.close).toBe("function");
    expect(typeof conn.healthCheck).toBe("function");
    conn.close();
  });
});
