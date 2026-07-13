import { describe, expect, it } from "vitest";
import { formatQueryValue, formatTable } from "../../src/cli/commands/query.js";

describe("query output formatting", () => {
  it("keeps scalar values unchanged in non-verbose output", () => {
    expect(formatQueryValue("src/index.ts", false)).toBe("src/index.ts");
    expect(formatQueryValue(42, false)).toBe("42");
    expect(formatQueryValue(null, false)).toBe("null");
  });

  it("summarizes Neo4j nodes in non-verbose output", () => {
    const node = {
      labels: ["Function"],
      properties: {
        name: "processPayment",
        filePath: "/repo/src/payments.ts",
        startLine: 14,
        endLine: 21,
        snippet: "function processPayment(order) { /* long code */ }",
      },
    };

    expect(formatQueryValue(node, false)).toBe(
      "Function processPayment (/repo/src/payments.ts:14)"
    );
  });

  it("preserves all object data in verbose output", () => {
    const node = {
      labels: ["Function"],
      properties: {
        name: "processPayment",
        filePath: "/repo/src/payments.ts",
        startLine: 14,
        snippet: "function processPayment(order) { /* long code */ }",
      },
    };

    expect(formatQueryValue(node, true)).toBe(JSON.stringify(node));
  });

  it("does not truncate file column values", () => {
    const file = "/repo/services/payments/src/domain/process-payment.ts";
    const output = formatTable(
      ["caller", "file"],
      [["processPayment", file]],
      24
    );

    expect(output).toContain(file);
    expect(output).not.toContain("/repo/services…");
  });
});
