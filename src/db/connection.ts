import neo4j, { type Driver, type Session } from "neo4j-driver";

export interface ConnectionConfig {
  uri: string;
  username: string;
  password: string;
}

export interface DbConnection {
  driver: Driver;
  session(): Session;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

export function createConnection(config: ConnectionConfig): DbConnection {
  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(config.username, config.password)
  );

  return {
    driver,
    session() {
      return driver.session();
    },
    async healthCheck() {
      try {
        const session = driver.session();
        await session.run("RETURN 1");
        await session.close();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await driver.close();
    },
  };
}
