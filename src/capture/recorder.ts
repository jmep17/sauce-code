import type { BrowserContext, Route } from "playwright";
import { isTextContentType } from "../util/url.js";
import type { CapturedCall } from "./types.js";

export interface Recorder {
  calls: CapturedCall[];
  /** Mark the page URL that subsequent calls originate from. */
  setCurrentPage: (url: string) => void;
  stop: () => Promise<void>;
}

/**
 * Attach a single context-level interceptor that captures EVERY request and its
 * full response, then passes the response through unchanged.
 *
 * Why `route.fetch()` instead of `page.on('response')` + `response.body()`:
 * the latter is lossy — bodies can be garbage-collected and `body()` throws for
 * redirects and some resource types. `route.fetch()` performs the real request
 * and hands us an APIResponse we fully own, so the body is always readable.
 *
 * `extraRoutes` lets callers (e.g. the Auth0 stub) register handlers that run
 * BEFORE this catch-all; Playwright invokes the most recently added handler
 * first, so the stub is attached after this and wins for its URLs.
 */
export async function attachRecorder(
  context: BrowserContext,
  options: { shouldRecord?: (url: string) => boolean } = {},
): Promise<Recorder> {
  const calls: CapturedCall[] = [];
  let currentPage = "";

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    const started = Date.now();

    // Only intercept http(s); let data:/blob: pass straight through.
    if (!/^https?:/i.test(url)) {
      await route.continue();
      return;
    }

    let response;
    try {
      response = await route.fetch();
    } catch (err) {
      calls.push({
        method,
        url,
        resourceType: request.resourceType(),
        requestHeaders: request.headers(),
        requestBodyBase64: request.postDataBuffer()?.toString("base64"),
        status: 0,
        responseHeaders: {},
        contentType: "",
        bodyBase64: "",
        bodyEncoding: "utf8",
        timingMs: Date.now() - started,
        fromPage: currentPage,
        error: err instanceof Error ? err.message : String(err),
      });
      // Let the browser attempt the request itself so the page isn't broken.
      await route.continue().catch(() => undefined);
      return;
    }

    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    let bodyBuf: Buffer = Buffer.alloc(0);
    try {
      bodyBuf = await response.body();
    } catch {
      /* some 204/304 responses have no body */
    }

    if (options.shouldRecord?.(url) ?? true) {
      const isText = isTextContentType(contentType);
      calls.push({
        method,
        url,
        resourceType: request.resourceType(),
        requestHeaders: request.headers(),
        requestBodyBase64: request.postDataBuffer()?.toString("base64"),
        status: response.status(),
        statusText: response.statusText(),
        responseHeaders: headers,
        contentType,
        bodyBase64: bodyBuf.toString("base64"),
        bodyEncoding: isText ? "utf8" : "base64",
        timingMs: Date.now() - started,
        fromPage: currentPage,
      });
    }

    await route.fulfill({ response }).catch(async () => {
      // If fulfill-by-response fails (rare), reconstruct from the buffer.
      await route
        .fulfill({
          status: response!.status(),
          headers,
          body: bodyBuf,
        })
        .catch(() => undefined);
    });
  });

  return {
    calls,
    setCurrentPage: (url: string) => {
      currentPage = url;
    },
    stop: async () => {
      await context.unroute("**/*").catch(() => undefined);
    },
  };
}
