# sauce-code

Point `sauce-code` at **any** Vite, Next.js, or Astro app — local or remote — and it will run the
app, automatically discover every API call it makes, and re-launch it against **auto-generated
[MSW](https://mswjs.io) mocks**. The result: you can run and test the app in isolation, with no live
backend and no real login.

If the app uses an authentication service like **Auth0**, `sauce-code` injects a **fake session** so
the app behaves as if a user is logged in — without ever contacting the real tenant, so the configured
"allowed callback URL" is irrelevant.

## What it does

1. **Select** a repository (local path or remote git URL) and a branch — interactively or via flags.
2. **Worktree** — creates a git worktree of that branch inside `./worktrees/` (remote repos are
   mirror-cloned into `./.cache/` first).
3. **Detect** the framework (Vite / Next.js / Astro / SvelteKit / Remix / CRA), the dev command and
   port, the package manager, and any Auth0 configuration (from dependencies + `.env*`).
4. **Boot** — installs dependencies and starts the dev server.
5. **Capture** — drives the app with Playwright, intercepting **every** network request and recording
   the full request/response, while:
   - **injecting a fake Auth0 session** (mints a real RS256 token + JWKS, stubs the tenant endpoints,
     and seeds the SPA cache), and
   - **auto-crawling** internal links to exercise multiple routes.
6. **Generate** MSW v2 handlers from the captured calls (one per `method + path`, de-duplicated, with
   query-variant branching and binary support).
7. **Re-launch** the app on a fresh port with the mocks auto-injected, ready to use.

The raw capture log and a summary are written to `./output/<repo>-<branch>/`.

## Install

```bash
npm install
npm run build
npm link                          # puts the `sauce-code` command on your PATH
npx playwright install chromium   # required for the capture step
```

`npm link` symlinks the built `dist/cli.js` as a global `sauce-code` binary. Re-run `npm run build`
after changing source (the link points at `dist/`, not `src/`). If npm's global bin directory isn't on
your `PATH` (common with nvm/fnm/Homebrew node), either add it — `export PATH="$(npm prefix -g)/bin:$PATH"` —
or skip the global command and run from source instead:

```bash
npm run dev -- --repo ./my-app --branch main   # tsx src/cli.ts, no build/link needed
```

## Usage

```bash
# Interactive: prompts for repo source + branch
sauce-code

# Non-interactive
sauce-code --repo ./my-app --branch main
sauce-code --repo https://github.com/owner/app.git --branch develop --debug
```

### Options

| Flag | Description |
| ---- | ----------- |
| `--repo <path\|url>` | Local repo path or remote git URL (prompted if omitted) |
| `--branch <name>` | Branch to check out (prompted if omitted) |
| `--depth <n>` | Crawl depth from the entry route (default: 2) |
| `--max-pages <n>` | Max pages to visit while crawling (default: 25) |
| `--headed` | Run the browser visibly (default: headless) |
| `--keep` | Keep the worktree after the run |
| `--no-relaunch` | Only capture + generate mocks; don't re-launch the app |
| `--debug` | Verbose logging (dev server + crawler output) |

## How the Auth0 stub works

`sauce-code` never talks to the real Auth0 tenant. It:

- mints a **real RS256-signed** id/access token with a freshly generated keypair and publishes the
  matching **JWKS**, so even SDKs that validate signatures pass;
- stubs the tenant endpoints — `/.well-known/openid-configuration`, JWKS, `/authorize`,
  `/oauth/token`, `/userinfo`;
- **short-circuits `/authorize`** by redirecting straight back to the app's callback with a fake
  `code` + echoed `state` (and serves the `web_message` variant used by silent auth). Because Auth0 is
  never contacted, the real allowed-callback-URL configuration doesn't matter;
- for SPAs (`@auth0/auth0-react`, `@auth0/auth0-spa-js`), it also **seeds the `@@auth0spajs@@`
  localStorage cache** so the app is authenticated on first paint with zero network.

`@auth0/nextjs-auth0` (server-side session) is supported on a best-effort basis; SPA is the primary,
fully-supported path.

## Generated output

Inside the worktree:

```
mocks/handlers.ts   # MSW http handlers, one per captured route
mocks/browser.ts    # setupWorker(...handlers)
mocks/start.ts      # starts the worker (dev only)
mocks/auto.ts       # auto-start entry injected into the app
public/mockServiceWorker.js   # via `msw init`
```

The bootstrap is wired into the app entry idempotently (markers: `sauce-code:mock-bootstrap`):
Vite/SvelteKit via `index.html`, Next.js via a client provider in the layout, Astro via a client
`<script>`, with an HTML fallback for anything else.

## Verifying

Two harnesses cover the pipeline without needing the network-restricted browser download:

```bash
npm run verify:generate   # capture → normalize → MSW codegen, executed via msw/node
npm run verify:fixture    # git worktree → detect → install → dev server → API → inject
```

Both run against `examples/vite-auth0-app/` — a Vite + React + `@auth0/auth0-react` fixture with a
login-gated dashboard that fetches `/api/messages`. To exercise the **authoritative-mock** check, run
the mocked app with `SAUCE_DISABLE_API=1` set on the dev server: the dashboard should still render the
captured data, proving MSW (not the live backend) is serving it.

## Notes & limitations

- The Playwright capture step requires a Chromium browser (`npx playwright install chromium`). In
  network-restricted environments where `cdn.playwright.dev` is blocked, install it where the download
  is permitted, or point Playwright at a system Chromium.
- Only **client-side** requests are mocked (the browser service worker). Next.js server-side fetches
  in RSC/route handlers are not intercepted.
- True WebSocket traffic is out of scope; REST/fetch/XHR (including SSE-as-fetch) is captured.
