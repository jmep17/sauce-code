import { isSameOrigin, isTextContentType, requestKey, safeParseUrl, stableQuery } from "../util/url.js";
import type { CapturedCall, MockRoute } from "../capture/types.js";

/** Headers we never copy into mocks (hop-by-hop / encoding-sensitive). */
const DROP_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "strict-transport-security",
  "alt-svc",
  "date",
  "server",
  "x-powered-by",
]);

/** Bodies larger than this (decoded bytes) are truncated to keep handlers small. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface NormalizeOptions {
  origin: string;
  /** Auth provider hostnames to exclude from generated mocks. */
  authHosts: string[];
}

export interface NormalizeResult {
  routes: MockRoute[];
  /** Count of captured calls that were skipped (assets, auth, errors, no body). */
  skipped: number;
}

/**
 * Collapse captured calls into deduped mock routes (one per method+path),
 * keeping the richest successful sample and recording materially different
 * per-query variants. Bodies are inlined (base64 for binary) so the generated
 * handlers are fully portable and need no fixture imports.
 */
export function normalize(
  calls: CapturedCall[],
  opts: NormalizeOptions,
): NormalizeResult {
  let skipped = 0;

  const apiCalls = calls.filter((c) => {
    if (c.error || c.status === 0) return (skipped++, false);
    if (!isApiResource(c)) return (skipped++, false);
    if (isAuthHost(c.url, opts.authHosts)) return (skipped++, false);
    if (c.status === 304) return (skipped++, false); // not-modified, no body
    return true;
  });

  const groups = new Map<string, CapturedCall[]>();
  for (const c of apiCalls) {
    const key = requestKey(c.method, c.url);
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const routes: MockRoute[] = [];

  for (const [, samples] of groups) {
    const primary = pickPrimary(samples);
    const u = safeParseUrl(primary.url);
    if (!u) continue;

    const sameOrigin = isSameOrigin(primary.url, opts.origin);
    const route: MockRoute = {
      method: primary.method.toUpperCase(),
      path: u.pathname,
      absolute: sameOrigin ? undefined : `${u.origin}${u.pathname}`,
      status: primary.status,
      responseHeaders: safeHeaders(primary.responseHeaders),
      contentType: primary.contentType,
      bodyEncoding: primary.bodyEncoding,
      body: decodeBody(primary),
      sampleCount: samples.length,
    };

    // Detect query-dependent variants worth preserving.
    const byQuery = new Map<string, CapturedCall>();
    for (const s of samples) {
      const q = stableQuery(s.url);
      if (q && !byQuery.has(q)) byQuery.set(q, s);
    }
    if (byQuery.size > 1 && distinctBodies([...byQuery.values()])) {
      route.variants = [...byQuery.entries()].map(([query, sample]) => ({
        query,
        status: sample.status,
        body: decodeBody(sample),
      }));
    }

    routes.push(route);
  }

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { routes, skipped };
}

/** Decode a captured body into the inline string we embed in the handler. */
function decodeBody(sample: CapturedCall): string {
  const buf = Buffer.from(sample.bodyBase64, "base64");
  const truncated = buf.length > MAX_BODY_BYTES ? buf.subarray(0, MAX_BODY_BYTES) : buf;
  return sample.bodyEncoding === "utf8"
    ? truncated.toString("utf8")
    : truncated.toString("base64");
}

function isApiResource(c: CapturedCall): boolean {
  if (c.resourceType === "xhr" || c.resourceType === "fetch") return true;
  if (c.resourceType === "document" && isTextContentType(c.contentType)) {
    return /json|xml/i.test(c.contentType);
  }
  return false;
}

function isAuthHost(url: string, authHosts: string[]): boolean {
  const u = safeParseUrl(url);
  if (!u) return false;
  return authHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

function pickPrimary(samples: CapturedCall[]): CapturedCall {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const pool = ok.length ? ok : samples;
  return pool[pool.length - 1]!;
}

function distinctBodies(samples: CapturedCall[]): boolean {
  return new Set(samples.map((s) => s.bodyBase64)).size > 1;
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (DROP_HEADERS.has(lower)) continue;
    out[lower] = v;
  }
  return out;
}
