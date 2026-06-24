/**
 * Verification harness for the non-browser pipeline stages against the real
 * fixture app: git worktree, framework/pm/auth detection, dependency install,
 * dev-server boot, and live API serving.
 *
 * The Playwright capture + Auth0 browser flow require a real Chromium, which is
 * blocked in this environment (cdn.playwright.dev is denied by egress policy),
 * so those steps are covered by scripts/verify-generate.ts and by design.
 *
 * Run: npx tsx scripts/verify-fixture.ts
 */
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { run } from "../src/util/exec.js";
import { addWorktree } from "../src/git/worktree.js";
import { listBranches } from "../src/git/branches.js";
import { findAppDir } from "../src/detect/packageJson.js";
import { detectFramework } from "../src/detect/framework.js";
import { detectPackageManager } from "../src/detect/packageManager.js";
import { detectAuth } from "../src/detect/auth.js";
import { installDeps } from "../src/server/install.js";
import { startDevServer } from "../src/server/devserver.js";
import { generateMswFiles } from "../src/generate/msw.js";
import { injectMocks } from "../src/inject/mocks.js";
import { buildSpaSeed } from "../src/capture/spa-seed.js";
import type { MockRoute } from "../src/capture/types.js";

const checks: Array<[string, boolean]> = [];
const check = (name: string, cond: boolean) => checks.push([name, cond]);

async function main() {
  const fixture = path.resolve("examples/vite-auth0-app");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sauce-fixture-"));
  const repo = path.join(tmp, "repo");
  const worktree = path.join(tmp, "worktree");

  // 1. Build a throwaway git repo from the fixture so worktree add works.
  await fs.cp(fixture, repo, { recursive: true });
  await run("git", ["-C", repo, "init", "-b", "main"]);
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"]);

  // 2. List branches + create a worktree.
  const { branches, current } = await listBranches(repo);
  check("lists the main branch", branches.includes("main"));
  check("detects current branch", current === "main");
  const wt = await addWorktree(repo, "main", worktree);
  check("worktree created", !!(await fs.stat(path.join(wt.dir, "package.json")).catch(() => null)));

  // 3. Detection.
  const app = await findAppDir(wt.dir);
  const framework = await detectFramework(app.dir, app.pkg);
  const pm = await detectPackageManager(app.dir);
  const auth = await detectAuth(app.dir, app.pkg);
  check("framework = vite", framework.name === "vite");
  check("dev script resolved", framework.devScript === "dev");
  check("config port read (5173)", framework.configPort === 5173);
  check("package manager = npm", pm.pm === "npm");
  check("auth flavor = auth0-spa", auth.flavor === "auth0-spa");
  check("auth domain parsed", auth.domain === "sauce-fixture.us.auth0.com");
  check("auth clientId parsed", !!auth.clientId);
  // Distinct from DEFAULT_SCOPE, so this proves env parsing (not a coincidental match).
  check("auth scope parsed from env", auth.scope === "openid profile email read:reports");

  // 4. Install deps.
  await installDeps(app.dir, pm);
  check("node_modules installed", !!(await fs.stat(path.join(app.dir, "node_modules", "vite")).catch(() => null)));

  // 5. Boot the dev server + hit the live API.
  const port = framework.configPort ?? framework.defaultPort;
  const dev = await startDevServer({
    appDir: app.dir,
    command: pm.run("dev", ["--port", String(port)]).command,
    args: pm.run("dev", ["--port", String(port)]).args,
    expectedPort: port,
    env: { PORT: String(port) },
  });
  try {
    check("dev server has a url", /^http:\/\/localhost:\d+$/.test(dev.url));
    const msgRes = await fetch(`${dev.url}/api/messages`);
    const msgs = (await msgRes.json()) as Array<{ from: string }>;
    check("GET /api/messages serves live data", msgRes.status === 200 && msgs[0]?.from === "real-backend");
    const profRes = await fetch(`${dev.url}/api/profile`);
    const prof = (await profRes.json()) as { source: string };
    check("GET /api/profile serves live data", prof.source === "live-api");
    const html = await (await fetch(dev.url)).text();
    check("index.html serves the app root", html.includes('id="root"'));
  } finally {
    await dev.stop();
  }

  // 6. Inject mocks into the worktree (writes files, msw init, edits index.html).
  const sampleRoutes: MockRoute[] = [
    {
      method: "GET",
      path: "/api/messages",
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      contentType: "application/json",
      bodyEncoding: "utf8",
      body: JSON.stringify([{ id: 1, from: "mock", text: "mocked!" }]),
      sampleCount: 1,
    },
  ];
  // Build the fake-session seed the same way the pipeline does, from detected auth.
  const authSeed = buildSpaSeed({
    clientId: auth.clientId ?? "sauce-code-client",
    audience: auth.audience ?? "default",
    idToken: "fake.id.token",
    accessToken: "fake.access.token",
    user: { sub: "auth0|fixture", name: "Sauce Tester" },
    scope: auth.scope,
  });
  const files = generateMswFiles(sampleRoutes, { authSeed });
  check("authSeedTs emitted", !!files.authSeedTs);
  check(
    "authSeedTs has the token cache key",
    !!files.authSeedTs?.includes("@@auth0spajs@@::FAKEclientIDfixture0000000::https://sauce-fixture/api::openid profile email read:reports"),
  );
  check("authSeedTs has the @@user@@ key", !!files.authSeedTs?.includes("@@user@@"));
  check(
    "authSeedTs has the manifest key",
    !!files.authSeedTs?.includes('"@@auth0spajs@@::FAKEclientIDfixture0000000"'),
  );

  const injected = await injectMocks({ appDir: app.dir, framework, pm, files });

  const exists = async (p: string) => !!(await fs.stat(path.join(app.dir, p)).catch(() => null));
  check("mocks/handlers.ts written", await exists("mocks/handlers.ts"));
  check("mocks/browser.ts written", await exists("mocks/browser.ts"));
  check("mocks/auto.ts written", await exists("mocks/auto.ts"));
  check("mocks/auth-seed.ts written", await exists("mocks/auth-seed.ts"));
  const autoTs = await fs.readFile(path.join(app.dir, "mocks", "auto.ts"), "utf8");
  check("auto.ts imports the auth seed first", autoTs.includes('import "./auth-seed";'));
  check("service worker installed", injected.workerInstalled);
  check("public/mockServiceWorker.js exists", await exists("public/mockServiceWorker.js"));
  const indexHtml = await fs.readFile(path.join(app.dir, "index.html"), "utf8");
  check("index.html has injection marker", indexHtml.includes("sauce-code:mock-bootstrap"));
  check("index.html references /mocks/auto.ts", indexHtml.includes("/mocks/auto.ts"));

  // Re-inject must be idempotent (no duplicate markers).
  await injectMocks({ appDir: app.dir, framework, pm, files });
  const indexHtml2 = await fs.readFile(path.join(app.dir, "index.html"), "utf8");
  const markerCount = indexHtml2.split("sauce-code:mock-bootstrap:start").length - 1;
  check("injection is idempotent", markerCount === 1);

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  report();
}

function report() {
  let ok = true;
  for (const [name, pass] of checks) {
    process.stdout.write(`${pass ? "✓" : "✗"} ${name}\n`);
    if (!pass) ok = false;
  }
  process.stdout.write(ok ? "\nALL CHECKS PASSED\n" : "\nSOME CHECKS FAILED\n");
  process.exit(ok ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
