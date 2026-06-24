/**
 * Verification harness for the capture → normalize → MSW codegen path.
 *
 * Builds synthetic captured calls (as Playwright's recorder would produce),
 * runs the real normalize + generator, writes the generated handlers to disk,
 * loads them, and serves them through msw/node to confirm the mocks actually
 * reproduce the captured responses. No browser required.
 *
 * Run: npx tsx scripts/verify-generate.ts
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setupServer } from "msw/node";
import { normalize } from "../src/generate/normalize.js";
import { generateMswFiles } from "../src/generate/msw.js";
import type { CapturedCall } from "../src/capture/types.js";
import { writeFile, ensureDir } from "../src/util/fs.js";

// The app's own origin. Same-origin API calls become RELATIVE matchers
// ("/api/..."), which resolve against location.origin in the browser (the real
// runtime) but have no base in msw/node, so they can't be exercised here.
const APP_ORIGIN = "http://localhost:3000";
// We point the captured API calls at a DIFFERENT origin so normalize emits
// ABSOLUTE matchers — identical response logic, but matchable in msw/node. This
// lets us verify status/body/variant/binary handling without a browser.
const API_ORIGIN = "http://localhost:5173";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

const calls: CapturedCall[] = [
  {
    method: "GET",
    url: `${API_ORIGIN}/api/messages`,
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify([{ id: 1, text: "hello" }])),
    bodyEncoding: "utf8",
    timingMs: 5,
  },
  {
    method: "GET",
    url: `${API_ORIGIN}/api/profile`,
    resourceType: "xhr",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify({ plan: "pro" })),
    bodyEncoding: "utf8",
    timingMs: 4,
  },
  {
    method: "POST",
    url: `${API_ORIGIN}/api/error`,
    resourceType: "fetch",
    requestHeaders: {},
    status: 422,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify({ error: "bad" })),
    bodyEncoding: "utf8",
    timingMs: 3,
  },
  // Query variants: same path, different body per ?type=
  {
    method: "GET",
    url: `${API_ORIGIN}/api/list?type=a&_=111`,
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify({ kind: "a" })),
    bodyEncoding: "utf8",
    timingMs: 3,
  },
  {
    method: "GET",
    url: `${API_ORIGIN}/api/list?type=b&_=222`,
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify({ kind: "b" })),
    bodyEncoding: "utf8",
    timingMs: 3,
  },
  // Binary response.
  {
    method: "GET",
    url: `${API_ORIGIN}/api/blob`,
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/octet-stream" },
    contentType: "application/octet-stream",
    bodyBase64: Buffer.from([1, 2, 3, 4, 250]).toString("base64"),
    bodyEncoding: "base64",
    timingMs: 3,
  },
  // Auth host call — must be excluded from generated mocks.
  {
    method: "POST",
    url: "https://sauce-fixture.us.auth0.com/oauth/token",
    resourceType: "fetch",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    bodyBase64: b64(JSON.stringify({ access_token: "x" })),
    bodyEncoding: "utf8",
    timingMs: 3,
  },
  // Static asset — must be skipped (not xhr/fetch).
  {
    method: "GET",
    url: `${API_ORIGIN}/logo.png`,
    resourceType: "image",
    requestHeaders: {},
    status: 200,
    responseHeaders: { "content-type": "image/png" },
    contentType: "image/png",
    bodyBase64: b64("not-real-png"),
    bodyEncoding: "base64",
    timingMs: 3,
  },
];

const checks: Array<[string, boolean]> = [];
function check(name: string, cond: boolean): void {
  checks.push([name, cond]);
}

async function main() {
  const { routes, skipped } = normalize(calls, {
    origin: APP_ORIGIN,
    authHosts: ["sauce-fixture.us.auth0.com"],
  });

  const paths = routes.map((r) => `${r.method} ${r.path}`).sort();
  check("excludes auth host", !paths.some((p) => p.includes("oauth/token")));
  check("skips static asset", !paths.some((p) => p.includes("logo.png")));
  check("keeps GET /api/messages", paths.includes("GET /api/messages"));
  check("keeps POST /api/error (422)", paths.includes("POST /api/error"));
  check("collapses /api/list to one route", paths.filter((p) => p === "GET /api/list").length === 1);
  check("skipped count > 0", skipped > 0);

  const listRoute = routes.find((r) => r.path === "/api/list");
  check("/api/list has 2 variants", (listRoute?.variants?.length ?? 0) === 2);

  // Generate + write the handlers, then load and serve them.
  const files = generateMswFiles(routes);
  // Inside the project so Node resolves `msw` from the local node_modules.
  const dir = path.join(process.cwd(), ".cache", "verify");
  await ensureDir(dir);
  // Written as .ts and loaded via the tsx loader, exactly as a bundler would.
  await writeFile(path.join(dir, "handlers.ts"), files.handlersTs);

  const mod = await import(pathToFileURL(path.join(dir, "handlers.ts")).href);
  const handlers = mod.handlers as Parameters<typeof setupServer>;
  check("handlers array non-empty", Array.isArray(handlers) && handlers.length > 0);

  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: "error" });
  try {
    const messages = await (await fetch(`${API_ORIGIN}/api/messages`)).json();
    check("GET /api/messages mocked", JSON.stringify(messages) === JSON.stringify([{ id: 1, text: "hello" }]));

    const errRes = await fetch(`${API_ORIGIN}/api/error`, { method: "POST" });
    check("POST /api/error preserves 422", errRes.status === 422);

    const listA = await (await fetch(`${API_ORIGIN}/api/list?type=a`)).json();
    const listB = await (await fetch(`${API_ORIGIN}/api/list?type=b`)).json();
    check("variant a serves kind=a", (listA as { kind: string }).kind === "a");
    check("variant b serves kind=b", (listB as { kind: string }).kind === "b");

    const blobRes = await fetch(`${API_ORIGIN}/api/blob`);
    const blobBytes = new Uint8Array(await blobRes.arrayBuffer());
    check(
      "binary body roundtrips",
      blobBytes.length === 5 && blobBytes[0] === 1 && blobBytes[4] === 250,
    );
    check("binary content-type preserved", blobRes.headers.get("content-type") === "application/octet-stream");
  } finally {
    server.close();
  }

  report();
}

function report(): void {
  let ok = true;
  for (const [name, pass] of checks) {
    process.stdout.write(`${pass ? "✓" : "✗"} ${name}\n`);
    if (!pass) ok = false;
  }
  process.stdout.write(ok ? "\nALL CHECKS PASSED\n" : "\nSOME CHECKS FAILED\n");
  process.exit(ok ? 0 : 1);
}

void main();
