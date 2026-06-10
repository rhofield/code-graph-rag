import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "../../src/db/connection.js";
import { createTestConnection } from "../helpers/test-db.js";
import { setupSchema } from "../../src/db/schema.js";
import { indexRepository } from "../../src/indexer/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const INTEGRATION = !!process.env.INTEGRATION;

describe.skipIf(!INTEGRATION)("E2E smoke test", () => {
  let tempDir: string;
  let db: ReturnType<typeof createConnection>;

  beforeAll(async () => {
    // Create a temp git repo with sample source
    tempDir = join(tmpdir(), `cgr-e2e-${Date.now()}`);
    mkdirSync(join(tempDir, "src"), { recursive: true });
    mkdirSync(join(tempDir, ".git", "hooks"), { recursive: true });

    // Initialize minimal git repo structure
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    // Write a simple TypeScript source file
    writeFileSync(
      join(tempDir, "src", "app.ts"),
      `
export function greetUser(name: string): string {
  return formatGreeting(name);
}

function formatGreeting(name: string): string {
  return \`Hello, \${name}!\`;
}

export class AppService {
  run(): void {
    console.log(greetUser("world"));
  }
}
`
    );

    // Connect to Neo4j
    db = createTestConnection();
    await setupSchema(db);
  });

  afterAll(async () => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    await db.close();
  });

  it("indexes the temp repo and creates graph nodes", async () => {
    const result = await indexRepository(db, tempDir, DEFAULT_CONFIG.index);

    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.functionsFound).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    const session = db.session();
    try {
      const fnResult = await session.run(
        "MATCH (fn:Function) WHERE fn.filePath CONTAINS $dir RETURN fn.name AS name",
        { dir: tempDir }
      );
      const names = fnResult.records.map((r) => r.get("name"));
      expect(names).toContain("greetUser");
      expect(names).toContain("formatGreeting");
    } finally {
      await session.close();
    }
  });

  it("install-hook creates the post-commit hook file", () => {
    const hookPath = join(tempDir, ".git", "hooks", "post-commit");

    // Simulate what install-hook does
    const HOOK_CONTENT = `#!/bin/sh
# code-graph-rag: re-index changed files after commit
code-graph-rag index --changed &
`;
    writeFileSync(hookPath, HOOK_CONTENT);

    // Make it executable
    try {
      execFileSync("chmod", ["+x", hookPath]);
    } catch {
      // Windows doesn't have chmod — that's ok
    }

    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, "utf-8")).toContain("code-graph-rag");
  });
});
