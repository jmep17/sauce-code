import type { BrowserContext, Page } from "playwright";
import { isSameOrigin, normalizeForVisit, safeParseUrl } from "../util/url.js";
import type { Recorder } from "./recorder.js";

export interface CrawlOptions {
  context: BrowserContext;
  recorder: Recorder;
  startUrl: string;
  maxDepth: number;
  maxPages: number;
  onVisit?: (url: string, index: number) => void;
}

/**
 * Breadth-first crawl of same-origin routes, capturing API calls on each page.
 *
 * Handles both classic `<a href>` links and SPA client-side routes: we collect
 * anchors and also try navigating via the History API by clicking same-origin
 * links, then wait for the network to settle so XHR/fetch calls are captured.
 */
export async function crawl(opts: CrawlOptions): Promise<string[]> {
  const origin = new URL(opts.startUrl).origin;
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: opts.startUrl, depth: 0 },
  ];

  const page = await opts.context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => undefined));

  try {
    while (queue.length && visited.size < opts.maxPages) {
      const { url, depth } = queue.shift()!;
      const norm = normalizeForVisit(url);
      if (visited.has(norm)) continue;
      visited.add(norm);

      opts.recorder.setCurrentPage(url);
      opts.onVisit?.(url, visited.size);

      const ok = await visitPage(page, url);
      if (!ok) continue;

      if (depth >= opts.maxDepth) continue;
      const links = await collectLinks(page, origin);
      for (const link of links) {
        const n = normalizeForVisit(link);
        if (!visited.has(n)) queue.push({ url: link, depth: depth + 1 });
      }
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return [...visited];
}

async function visitPage(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch {
    return false;
  }
  // Let SPA hydration + initial data fetches fire and settle.
  await settle(page);
  return true;
}

/** Wait for the network to go quiet, then a short grace period for late fetches. */
async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    /* some apps keep a long-poll open; proceed anyway */
  }
  await page.waitForTimeout(750);
}

/** Collect same-origin navigable links from anchors and the router. */
async function collectLinks(page: Page, origin: string): Promise<string[]> {
  let hrefs: string[] = [];
  try {
    hrefs = await page.$$eval("a[href]", (els) =>
      els
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((h) => typeof h === "string" && h.length > 0),
    );
  } catch {
    return [];
  }

  const out = new Set<string>();
  for (const href of hrefs) {
    const u = safeParseUrl(href, origin);
    if (!u) continue;
    if (!isSameOrigin(u.toString(), origin)) continue;
    if (!/^https?:/.test(u.protocol)) continue;
    // Skip obvious file downloads.
    if (/\.(pdf|zip|png|jpe?g|gif|svg|ico|css|js|map|woff2?)$/i.test(u.pathname)) continue;
    out.add(u.toString());
  }
  return [...out];
}
