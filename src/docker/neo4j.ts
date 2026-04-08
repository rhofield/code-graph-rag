// src/docker/neo4j.ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CONTAINER_NAME = "rho-graph-neo4j";

function runDocker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

export function isDockerAvailable(): boolean {
  try {
    runDocker("info");
    return true;
  } catch {
    return false;
  }
}

export function getContainerStatus(): "running" | "stopped" | "not_found" {
  try {
    const result = runDocker(
      "inspect",
      "--format",
      "{{.State.Running}}",
      CONTAINER_NAME
    ).trim();
    return result === "true" ? "running" : "stopped";
  } catch {
    return "not_found";
  }
}

export function startNeo4j(composeFilePath: string): void {
  const status = getContainerStatus();
  if (status === "running") return;
  if (status === "stopped") {
    runDocker("start", CONTAINER_NAME);
    return;
  }
  const composePath = resolve(composeFilePath);
  execFileSync("docker", ["compose", "-f", composePath, "up", "-d"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

export function stopNeo4j(): void {
  const status = getContainerStatus();
  if (status === "running") {
    runDocker("stop", CONTAINER_NAME);
  }
}

export async function waitForNeo4j(
  uri: string,
  username: string,
  password: string,
  maxAttempts = 60
): Promise<boolean> {
  // First wait for the process to start via admin check
  let processReady = false;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER_NAME, "neo4j-admin", "server", "status"],
        { encoding: "utf-8", stdio: "pipe" }
      );
      processReady = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!processReady) return false;

  // Then wait for the Bolt port to accept connections
  const neo4j = await import("neo4j-driver");
  const driver = neo4j.default.driver(
    uri,
    neo4j.default.auth.basic(username, password)
  );
  try {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const session = driver.session();
        await session.run("RETURN 1");
        await session.close();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return false;
  } finally {
    await driver.close();
  }
}
