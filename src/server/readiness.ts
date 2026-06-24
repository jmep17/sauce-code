import getPort from "get-port";
import { delay } from "../util/exec.js";

/**
 * Poll a URL until the dev server responds. We accept any 2xx/3xx and also
 * 401/403 — an auth-gated server returning 401 is still "up".
 */
export async function waitForServer(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
      });
      // Any HTTP response at all means the socket is listening.
      if (res.status > 0) return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms (${lastError})`);
}

/** Find a free port, optionally preferring a specific one. */
export async function findFreePort(preferred?: number): Promise<number> {
  return getPort(preferred ? { port: preferred } : undefined);
}
