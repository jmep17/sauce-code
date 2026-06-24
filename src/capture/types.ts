/** A single captured network request/response pair. */
export interface CapturedCall {
  method: string;
  url: string;
  /** Playwright resource type: xhr, fetch, document, script, image, etc. */
  resourceType: string;
  requestHeaders: Record<string, string>;
  /** Request body, base64-encoded (undefined for bodyless requests). */
  requestBodyBase64?: string;
  status: number;
  statusText?: string;
  responseHeaders: Record<string, string>;
  contentType: string;
  /** Response body, base64-encoded. */
  bodyBase64: string;
  /** How the body should be interpreted when decoded. */
  bodyEncoding: "utf8" | "base64";
  /** Wall-clock duration of the underlying fetch, in ms. */
  timingMs: number;
  /** Page URL the call originated from. */
  fromPage?: string;
  /** True if route.fetch threw (network error / blocked). */
  error?: string;
}

export interface CaptureResult {
  calls: CapturedCall[];
  visitedPages: string[];
  origin: string;
}

/** A normalized, deduped route ready for MSW codegen. */
export interface MockRoute {
  method: string;
  /** Pathname used as the MSW matcher (relative for same-origin). */
  path: string;
  /** Absolute URL matcher when the call is cross-origin. */
  absolute?: string;
  status: number;
  responseHeaders: Record<string, string>;
  contentType: string;
  /** How `body` (and variant bodies) are encoded: utf8 text or base64 binary. */
  bodyEncoding: "utf8" | "base64";
  /** Inline response body (utf8 text or base64 for binary). */
  body: string;
  /** When the same path varies by query, alternative responses keyed by query. */
  variants?: Array<{ query: string; status: number; body: string }>;
  /** Number of captured samples that collapsed into this route. */
  sampleCount: number;
}
