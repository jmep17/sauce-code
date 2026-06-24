import { execa, type ResultPromise, type Options } from "execa";

/**
 * Registry of long-lived child processes (dev servers) so that SIGINT / crash
 * cleanup always tears them down. Short-lived `run` calls are not registered.
 */
const liveProcesses = new Set<ResultPromise>();

let cleanupInstalled = false;

export interface LongLivedHandle {
  proc: ResultPromise;
  /** Resolve with combined stdout lines seen so far (ring buffer). */
  recentOutput: () => string;
  stop: () => Promise<void>;
}

/** Run a command to completion, returning stdout. Throws on non-zero unless `reject:false`. */
export async function run(
  command: string,
  args: string[],
  options: Options = {},
): Promise<string> {
  const result = await execa(command, args, { ...options });
  return typeof result.stdout === "string" ? result.stdout : "";
}

/** Run a command, never rejecting; returns exit code + stdout + stderr. */
export async function runSafe(
  command: string,
  args: string[],
  options: Options = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(command, args, { ...options, reject: false });
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

/**
 * Spawn a long-lived process (e.g. a dev server). Output is streamed to the
 * provided onLine callback and kept in a small ring buffer for diagnostics.
 */
export function spawnLongLived(
  command: string,
  args: string[],
  options: Options & { onLine?: (line: string, stream: "stdout" | "stderr") => void } = {},
): LongLivedHandle {
  installGlobalCleanup();
  const { onLine, ...execaOptions } = options;
  const proc = execa(command, args, {
    ...execaOptions,
    stdout: "pipe",
    stderr: "pipe",
    // Detach into its own group so we can kill the whole tree.
    detached: false,
  });
  liveProcesses.add(proc);

  const ring: string[] = [];
  const pushLine = (line: string, stream: "stdout" | "stderr") => {
    ring.push(line);
    if (ring.length > 200) ring.shift();
    onLine?.(line, stream);
  };

  bindLineReader(proc.stdout, (line) => pushLine(line, "stdout"));
  bindLineReader(proc.stderr, (line) => pushLine(line, "stderr"));

  proc.catch(() => {
    // Swallow — exit handled by stop()/observers. Avoids unhandled rejection.
  });
  proc.finally?.(() => liveProcesses.delete(proc));

  const stop = async () => {
    liveProcesses.delete(proc);
    if (proc.exitCode !== null || proc.killed) return;
    try {
      proc.kill("SIGTERM");
      await Promise.race([
        proc.catch(() => undefined),
        delay(5000),
      ]);
    } finally {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  };

  return { proc, recentOutput: () => ring.join("\n"), stop };
}

function bindLineReader(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length) onLine(buffer);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kill every registered long-lived process. Used on fatal error / signals. */
export async function killAllProcesses(): Promise<void> {
  const procs = [...liveProcesses];
  liveProcesses.clear();
  await Promise.all(
    procs.map(async (proc) => {
      try {
        proc.kill("SIGTERM");
        await Promise.race([proc.catch(() => undefined), delay(3000)]);
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }),
  );
}

function installGlobalCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const onSignal = () => {
    void killAllProcesses().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("exit", () => {
    // Best-effort synchronous-ish kill; promises won't resolve on exit.
    for (const proc of liveProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });
}
