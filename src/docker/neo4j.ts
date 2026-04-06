// src/docker/neo4j.ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const CONTAINER_NAME = "code-graph-rag-neo4j";

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
  _uri: string,
  maxAttempts = 30
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync(
        "docker",
        ["exec", CONTAINER_NAME, "neo4j-admin", "server", "status"],
        { encoding: "utf-8", stdio: "pipe" }
      );
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}
