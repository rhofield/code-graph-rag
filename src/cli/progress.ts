export interface ProgressHeartbeat {
  update(message: string): void;
  stop(): void;
}

export function startProgressHeartbeat(
  initialMessage: string,
  options: {
    intervalMs?: number;
    stream?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
    now?: () => number;
  } = {}
): ProgressHeartbeat {
  const intervalMs = options.intervalMs ?? 30_000;
  const stream = options.stream ?? process.stderr;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let message = initialMessage;

  if (stream.isTTY) {
    return {
      update(nextMessage: string) {
        message = nextMessage;
      },
      stop() {},
    };
  }

  const writeHeartbeat = () => {
    const elapsedSeconds = Math.max(0, Math.floor((now() - startedAt) / 1000));
    stream.write(`[rho-graph] ${message} (${elapsedSeconds}s elapsed)\n`);
  };

  const timer = setInterval(writeHeartbeat, intervalMs);
  timer.unref?.();

  return {
    update(nextMessage: string) {
      message = nextMessage;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
