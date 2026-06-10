import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests share one Neo4j instance and some run global cleanups
    // (e.g. deleting all ProtoMethod nodes), so test files must not interleave.
    fileParallelism: !process.env.INTEGRATION,
  },
});
