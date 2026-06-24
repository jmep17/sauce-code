/** URL helpers for crawling and capture normalization. */

/** Volatile query keys that are stripped when keying/deduping requests. */
const CACHE_BUSTER_KEYS = new Set(["_", "t", "ts", "timestamp", "cachebust", "cb", "v"]);

export function safeParseUrl(input: string, base?: string): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

export function isSameOrigin(a: string, b: string): boolean {
  const ua = safeParseUrl(a);
  const ub = safeParseUrl(b);
  return !!ua && !!ub && ua.origin === ub.origin;
}

/** Normalize a URL for visited-set dedupe: drop hash, sort query, trim trailing slash. */
export function normalizeForVisit(input: string): string {
  const u = safeParseUrl(input);
  if (!u) return input;
  u.hash = "";
  const params = [...u.searchParams.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  u.search = "";
  for (const [k, v] of params) u.searchParams.append(k, v);
  let out = u.toString();
  if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
  return out;
}

/** Stable key for grouping captured requests: METHOD + pathname (cache busters dropped). */
export function requestKey(method: string, url: string): string {
  const u = safeParseUrl(url);
  const pathname = u ? u.pathname : url;
  return `${method.toUpperCase()} ${pathname}`;
}

/** Search params with cache-buster keys removed, as a sorted query string (or ""). */
export function stableQuery(url: string): string {
  const u = safeParseUrl(url);
  if (!u) return "";
  const entries = [...u.searchParams.entries()]
    .filter(([k]) => !CACHE_BUSTER_KEYS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

const TEXT_CONTENT_RE = /^(application\/(json|.*\+json|javascript|xml|.*\+xml)|text\/)/i;

export function isTextContentType(contentType: string): boolean {
  return TEXT_CONTENT_RE.test(contentType.trim());
}

export function isJsonContentType(contentType: string): boolean {
  return /^application\/(json|.*\+json)/i.test(contentType.trim());
}
