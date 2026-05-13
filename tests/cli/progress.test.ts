import { afterEach, describe, expect, it, vi } from "vitest";
import { startProgressHeartbeat } from "../../src/cli/progress.js";

describe("progress heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes periodic progress lines for non-interactive output", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let currentTime = 0;
    const heartbeat = startProgressHeartbeat("Indexing repository", {
      intervalMs: 1_000,
      now: () => currentTime,
      stream: {
        isTTY: false,
        write: (chunk: string) => {
          writes.push(chunk);
          return true;
        },
      },
    });

    currentTime = 1_000;
    vi.advanceTimersByTime(1_000);
    heartbeat.update("Parsing files 20/200");
    currentTime = 2_000;
    vi.advanceTimersByTime(1_000);
    heartbeat.stop();

    expect(writes).toEqual([
      "[rho-graph] Indexing repository (1s elapsed)\n",
      "[rho-graph] Parsing files 20/200 (2s elapsed)\n",
    ]);
  });

  it("does not write heartbeat lines when an interactive spinner is visible", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const heartbeat = startProgressHeartbeat("Indexing repository", {
      intervalMs: 1_000,
      stream: { isTTY: true, write },
    });

    vi.advanceTimersByTime(5_000);
    heartbeat.update("Parsing files 20/200");
    heartbeat.stop();

    expect(write).not.toHaveBeenCalled();
  });
});
