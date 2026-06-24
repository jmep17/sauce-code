import path from "node:path";
import { logger } from "./logger.js";
import type { RunConfig } from "./config.js";
import { ensureDir, slugify, writeJson, writeFile } from "./util/fs.js";
import { delay } from "./util/exec.js";
import { selectRepoSource, selectBranch } from "./prompts/select.js";
import { ensureMirror, localGitDir } from "./git/clone.js";
import { listBranches } from "./git/branches.js";
import { addWorktree, removeWorktree } from "./git/worktree.js";
import { findAppDir } from "./detect/packageJson.js";
import { detectFramework, portFlag } from "./detect/framework.js";
import { detectPackageManager } from "./detect/packageManager.js";
import { detectAuth } from "./detect/auth.js";
import { installDeps } from "./server/install.js";
import { startDevServer, type DevServer } from "./server/devserver.js";
import { findFreePort } from "./server/readiness.js";
import { launchBrowser, type BrowserSession } from "./capture/browser.js";
import { attachRecorder } from "./capture/recorder.js";
import { installAuth0Stub, type AuthStub } from "./capture/auth0-stub.js";
import { crawl } from "./capture/crawler.js";
import { normalize } from "./generate/normalize.js";
import { generateMswFiles } from "./generate/msw.js";
import { injectMocks } from "./inject/mocks.js";

/** Run the full capture → generate → relaunch pipeline. */
export async function run(config: RunConfig): Promise<void> {
  await Promise.all([
    ensureDir(config.cacheDir),
    ensureDir(config.worktreesDir),
    ensureDir(config.outputDir),
  ]);

  const cleanup: Array<() => Promise<void>> = [];
  const runCleanup = async () => {
    for (const fn of cleanup.reverse()) {
      await fn().catch(() => undefined);
    }
  };

  try {
    // ── 1. Select repo + branch ──────────────────────────────────────────
    const source = await selectRepoSource(config.repo);
    const gitDir =
      source.kind === "remote"
        ? await withSpinner(`Cloning ${source.value}`, () =>
            ensureMirror(source.value, config.cacheDir),
          )
        : localGitDir(source.value);

    const { branches, current } = await listBranches(gitDir);
    const branch = await selectBranch(branches, current, config.branch);

    // ── 2. Create worktree ───────────────────────────────────────────────
    const slug = slugify(`${path.basename(source.value)}-${branch}`);
    const dest = path.join(config.worktreesDir, slug);
    const wt = await withSpinner(`Creating worktree (${branch})`, () =>
      addWorktree(gitDir, branch, dest),
    );
    logger.info(`Worktree: ${wt.dir}${wt.reused ? " (reused)" : ""}`);
    if (!config.keep && !wt.reused) {
      cleanup.push(() => removeWorktree(gitDir, dest));
    }

    // ── 3. Detect framework / pm / auth ──────────────────────────────────
    const app = await findAppDir(wt.dir);
    const framework = await detectFramework(app.dir, app.pkg);
    const pm = await detectPackageManager(app.dir);
    const auth = await detectAuth(app.dir, app.pkg);
    logger.info(
      `Detected ${framework.label} · ${pm.pm} · ${
        auth.flavor === "none" ? "no auth" : auth.flavor
      }`,
    );
    if (auth.flavor !== "none") {
      logger.info(
        `Auth0: domain=${auth.domain ?? "?"} clientId=${auth.clientId ? "set" : "?"}`,
      );
    }

    // ── 4. Install + boot dev server ─────────────────────────────────────
    await withSpinner(`Installing dependencies (${pm.pm})`, () =>
      installDeps(app.dir, pm, (l) => logger.debug(l)),
    );

    // Prefer the framework's configured/default port, but fall back to a free
    // one so a stale/occupied port can't make us bind or probe the wrong server.
    const capturePort = await findFreePort(framework.configPort ?? framework.defaultPort);
    const runCmd = pm.run(framework.devScript, portFlag(framework.name, capturePort));
    const dev = await withSpinner(`Starting ${framework.label} dev server`, () =>
      startDevServer({
        appDir: app.dir,
        command: runCmd.command,
        args: runCmd.args,
        expectedPort: capturePort,
        env: { PORT: String(capturePort), NODE_ENV: "development" },
        onLine: (l) => logger.debug(l),
      }),
    );
    cleanup.push(() => dev.stop());
    logger.success(`Dev server ready at ${dev.url}`);

    // ── 5/6/7. Capture with Playwright (auth stub + crawl) ───────────────
    const capture = await captureApiCalls({ dev, auth, config });

    logger.success(
      `Captured ${capture.calls.length} calls across ${capture.visited.length} page(s)`,
    );

    // Persist raw capture for audit/debug.
    const outDir = path.join(config.outputDir, slug);
    await writeJson(path.join(outDir, "capture.json"), {
      origin: dev.url,
      branch,
      framework: framework.name,
      auth: auth.flavor,
      visited: capture.visited,
      calls: capture.calls,
      // Slim auth summary for debugging scope/seed issues; the tokenKey reveals
      // the scope baked into the relaunched app's localStorage cache key.
      authStub: capture.authStub
        ? {
            authHosts: capture.authStub.authHosts,
            user: capture.authStub.user,
            spaSeed: capture.authStub.spaSeed
              ? {
                  tokenKey: capture.authStub.spaSeed.tokenKey,
                  userKey: capture.authStub.spaSeed.userKey,
                  manifestKey: capture.authStub.spaSeed.manifestKey,
                }
              : undefined,
          }
        : undefined,
    });

    // ── 8a. Generate MSW handlers ────────────────────────────────────────
    const { routes, skipped } = normalize(capture.calls, {
      origin: dev.url,
      authHosts: capture.authStub?.authHosts ?? [],
    });
    if (routes.length === 0) {
      logger.warn(
        "No mockable API calls were captured. The app may make no client-side API calls, " +
          "or content was behind an auth wall that could not be bypassed.",
      );
    }
    logger.info(`Generated ${routes.length} mock route(s) (skipped ${skipped} non-API/aux calls)`);

    const files = generateMswFiles(routes, { authSeed: capture.authStub?.spaSeed });
    await writeFile(path.join(outDir, "summary.md"), renderSummary(routes, branch, framework.label));

    // Stop the capture dev server before mutating the worktree + relaunch.
    await dev.stop();

    // ── 8b. Inject mocks into the worktree ───────────────────────────────
    const injected = await withSpinner("Writing mocks + service worker into the app", () =>
      injectMocks({ appDir: app.dir, framework, pm, files, onLine: (l) => logger.debug(l) }),
    );
    logger.success(`Mocks written to ${path.relative(wt.dir, injected.mocksDir)} · entry: ${path.relative(wt.dir, injected.editedEntry)}`);

    if (config.noRelaunch) {
      logger.outro(
        `Done. Mocks generated. Run the app yourself in ${app.dir} (dev script: ${framework.devScript}).`,
      );
      return;
    }

    // ── 8c. Relaunch with mocks on a fresh port ──────────────────────────
    const mockPort = await findFreePort(capturePort + 1);
    const relaunchCmd = pm.run(framework.devScript, portFlag(framework.name, mockPort));
    const mockedDev = await withSpinner(`Relaunching with mocks (port ${mockPort})`, () =>
      startDevServer({
        appDir: app.dir,
        command: relaunchCmd.command,
        args: relaunchCmd.args,
        expectedPort: mockPort,
        env: { PORT: String(mockPort), NODE_ENV: "development" },
        onLine: (l) => logger.debug(l),
      }),
    );
    cleanup.push(() => mockedDev.stop());

    logger.success(`Mocked app running at ${mockedDev.url}`);
    logger.outro(
      `The app is now running against generated mocks at ${mockedDev.url}\n` +
        `Capture log: ${path.join(outDir, "capture.json")}\n` +
        `Press Ctrl+C to stop.`,
    );

    // Keep the mocked server alive until the user interrupts.
    await waitForever();
  } finally {
    await runCleanup();
  }
}

interface CaptureOutput {
  calls: import("./capture/types.js").CapturedCall[];
  visited: string[];
  authStub?: AuthStub;
}

async function captureApiCalls(args: {
  dev: DevServer;
  auth: import("./detect/auth.js").AuthInfo;
  config: RunConfig;
}): Promise<CaptureOutput> {
  const { dev, auth, config } = args;
  let session: BrowserSession | undefined;
  try {
    session = await launchBrowser({ headed: config.headed });

    // Register the recorder's catch-all FIRST, then the auth stub: Playwright runs
    // matching route handlers last-registered-first, so the stub (added last) wins
    // for the auth host and short-circuits /authorize, instead of the recorder
    // proxying it to the real tenant. The stub also runs before navigation so the
    // first load is authed.
    const recorder = await attachRecorder(session.context);

    let authStub: AuthStub | undefined;
    if (auth.flavor !== "none") {
      authStub = await installAuth0Stub(session.context, dev.url, auth);
      if (authStub) logger.info(`Injected fake Auth0 session (host: ${authStub.authHosts.join(", ")})`);
    }

    const visited = await withSpinner("Crawling + capturing API calls", () =>
      crawl({
        context: session!.context,
        recorder,
        startUrl: dev.url,
        maxDepth: config.depth,
        maxPages: config.maxPages,
        onVisit: (url, i) => logger.debug(`visit #${i}: ${url}`),
      }),
    );

    await recorder.stop();
    // Rebuild the SPA seed with the scope observed on the app's real /authorize
    // during the crawl, so the relaunched app's cache key matches and it never
    // redirects to the real tenant.
    if (authStub?.finalizeSpaSeed) {
      authStub = { ...authStub, spaSeed: await authStub.finalizeSpaSeed() };
    }
    return { calls: recorder.calls, visited, authStub };
  } finally {
    await session?.close();
  }
}

function renderSummary(
  routes: import("./capture/types.js").MockRoute[],
  branch: string,
  framework: string,
): string {
  const lines = [
    `# sauce-code mock summary`,
    ``,
    `- Branch: \`${branch}\``,
    `- Framework: ${framework}`,
    `- Mock routes: ${routes.length}`,
    ``,
    `| Method | Path | Status | Samples |`,
    `| ------ | ---- | ------ | ------- |`,
    ...routes.map(
      (r) => `| ${r.method} | \`${r.absolute ?? r.path}\` | ${r.status} | ${r.sampleCount} |`,
    ),
    ``,
  ];
  return lines.join("\n");
}

async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const s = logger.spinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(`${message} ✓`);
    return result;
  } catch (err) {
    s.stop(`${message} ✗`);
    throw err;
  }
}

async function waitForever(): Promise<void> {
  // Resolve only on SIGINT (handled by the global cleanup in util/exec).
  return new Promise<void>(() => {
    /* never resolves; process exits via signal */
    void delay;
  });
}
