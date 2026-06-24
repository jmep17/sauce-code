# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`sauce-code` is a Node 22 + TypeScript (ESM) CLI that points at any Vite/Next/Astro app (local or
remote), creates a git worktree of a chosen branch, drives the app with Playwright to capture every
API call (injecting a fake Auth0 session and auto-crawling internal links), generates MSW v2 handlers
from the captures, and re-launches the app with the mocks auto-injected. See `README.md` for the
user-facing overview.

## Commands

```bash
npm run build            # bundle src/cli.ts -> dist/cli.js (tsup)
npm run dev              # run the CLI from source (tsx src/cli.ts)
npm run typecheck        # tsc --noEmit (strict, noUncheckedIndexedAccess)
node dist/cli.js --help  # run the built CLI

npm run verify:generate  # capture -> normalize -> MSW codegen, executed via msw/node (no browser)
npm run verify:fixture   # git worktree -> detect -> install -> dev server -> live API -> inject

npx playwright install chromium   # required for the live capture step (postinstall attempts this)
```

There is no test runner; correctness is covered by the two `verify:*` harnesses in `scripts/`, each of
which prints `✓`/`✗` per check and exits non-zero on failure. Always run both after changing capture,
normalize, codegen, detection, server, git, or inject code. `verify:fixture` installs the fixture's npm
deps and boots a real Vite server, so it takes ~1 min and needs network to `registry.npmjs.org`.

## Architecture

The pipeline is orchestrated by `src/pipeline.ts` (`run(config)`), which wires the stages below in
order behind clack spinners, with a cleanup registry that tears down the dev server / browser / worktree
on success, error, or SIGINT. `src/cli.ts` only parses flags (`node:util` parseArgs) and builds the
`RunConfig`. Stages, by directory:

- **`git/`** — `clone.ts` mirror-clones remotes into `.cache/`; `worktree.ts` adds the worktree, with a
  three-step fallback (direct branch → `-b` tracking `origin/<branch>` → `--detach`; the detach case
  handles a local repo whose target branch is already checked out).
- **`detect/`** — `packageJson.ts` finds the app dir (walks monorepo workspaces); `framework.ts` maps
  deps/config to `{name, devScript, defaultPort}` and reads config ports via regex (never executes
  config); `packageManager.ts` derives commands from the lockfile; `auth.ts` parses `.env*` (parse-only,
  never loaded into our process) for Auth0 config.
- **`server/`** — `install.ts`, `devserver.ts` (spawns the dev server, scans stdout for the printed URL,
  races a fallback port), `readiness.ts` (polls; treats any HTTP response incl. 401 as "up").
- **`capture/`** — the core. `recorder.ts` installs a single `context.route('**/*')` that calls
  `route.fetch()` to perform the real request, records the full request/response, then
  `route.fulfill({response})` to pass through. **This is deliberate over `page.on('response')` +
  `response.body()`, which loses bodies and throws on redirects.** `auth0-stub.ts` mints an RS256
  token + matching JWKS, stubs the tenant endpoints, short-circuits `/authorize`, and seeds the
  `@@auth0spajs@@` localStorage cache. `crawler.ts` is a same-origin BFS.
- **`generate/`** — `normalize.ts` collapses captured calls into one `MockRoute` per `method+pathname`
  (drops cache-buster query keys, excludes auth hosts, skips non-xhr/fetch assets, records per-query
  variants); `msw.ts` emits the handler/browser/bootstrap TypeScript as strings.
- **`inject/`** — `mocks.ts` writes the mock files into the worktree, adds `msw`, runs `msw init`, and
  dispatches to a framework injector. `framework-vite.ts`/`generic.ts` inject a module `<script>` into
  `index.html`; `framework-next.ts` adds a client provider to the layout; `framework-astro.ts` adds a
  client script. All injection is idempotent via `sauce-code:mock-bootstrap` markers.

`capture/types.ts` defines `CapturedCall` (raw, base64 bodies) and `MockRoute` (normalized, inline
bodies). `util/exec.ts` holds the execa wrappers + the long-lived-process registry that powers signal
cleanup — spawn dev servers through `spawnLongLived`, not raw execa.

## Conventions and gotchas

- **ESM + NodeNext**: relative imports in `src/` must use `.js` extensions (e.g.
  `import { run } from "./pipeline.js"`) even though the files are `.ts`.
- **Auth0 nonce**: the id_token is minted *dynamically* per `/authorize`→`/oauth/token` exchange,
  reading the nonce/state from the authorize request (the SDK validates the returned token's nonce).
  Don't hoist token minting out of the route handler.
- **Generated MSW paths are relative** for same-origin calls (`/api/...`). They resolve against
  `location.origin` in the browser (the real runtime) but have NO base in `msw/node`, so
  `verify-generate.ts` points captures at a different origin to force absolute matchers it can exercise.
  Keep relative emission — it's correct for the browser; only the test works around it.
- Mocks are **client-side only** (browser service worker); Next.js server/RSC fetches aren't intercepted.
  True WebSockets are out of scope.
- Runtime dirs `worktrees/`, `output/`, `.cache/` are gitignored. The fixture's
  `examples/vite-auth0-app/.env` (fake values) is intentionally un-ignored via a `.gitignore` negation.
- Develop on the `claude/auto-mock-api-calls-3r0nns` branch; do not push elsewhere without permission.
