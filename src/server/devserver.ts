import { spawnLongLived, type LongLivedHandle, delay } from "../util/exec.js";
import { waitForServer } from "./readiness.js";

export interface DevServer {
  url: string;
  port: number;
  handle: LongLivedHandle;
  stop: () => Promise<void>;
}

export interface StartOptions {
  appDir: string;
  command: string;
  args: string[];
  /** Port we asked the server to use (used as a fallback if stdout is silent). */
  expectedPort: number;
  /** Extra environment variables for the dev server process. */
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  readyTimeoutMs?: number;
}

const URL_RE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i;

/**
 * Start a dev server as a long-lived child process. Scans stdout for the first
 * printed local URL; if none appears, falls back to the expected port. Resolves
 * once the server answers HTTP.
 */
export async function startDevServer(opts: StartOptions): Promise<DevServer> {
  let resolvedUrl: string | undefined;
  let resolveUrl: ((url: string) => void) | undefined;
  const urlFromStdout = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });

  const handle = spawnLongLived(opts.command, opts.args, {
    cwd: opts.appDir,
    env: { ...process.env, ...opts.env, FORCE_COLOR: "0", BROWSER: "none" },
    onLine: (line, stream) => {
      opts.onLine?.(line);
      if (!resolvedUrl) {
        const m = line.match(URL_RE);
        if (m) {
          resolvedUrl = normalizeUrl(m[0]!);
          resolveUrl?.(resolvedUrl);
        }
      }
      void stream;
    },
  });

  // Prefer the URL printed by the framework; otherwise assume the expected port.
  const fallbackUrl = `http://localhost:${opts.expectedPort}`;
  const url = await Promise.race([
    urlFromStdout,
    delay(12_000).then(() => fallbackUrl),
  ]);

  // Detect early process death (bad script, port conflict that aborts, etc.).
  if (handle.proc.exitCode !== null) {
    throw new Error(
      `Dev server exited early (code ${handle.proc.exitCode}):\n${handle.recentOutput()}`,
    );
  }

  try {
    await waitForServer(url, { timeoutMs: opts.readyTimeoutMs ?? 90_000 });
  } catch (err) {
    await handle.stop();
    const detail = handle.recentOutput().split("\n").slice(-40).join("\n");
    throw new Error(`${(err as Error).message}\n--- dev server output ---\n${detail}`);
  }

  const port = Number(new URL(url).port) || opts.expectedPort;
  return { url, port, handle, stop: handle.stop };
}

function normalizeUrl(raw: string): string {
  return raw.replace("0.0.0.0", "localhost").replace("127.0.0.1", "localhost");
}
