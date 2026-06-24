import { chromium, type Browser, type BrowserContext } from "playwright";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
}

/** Launch a chromium browser + a fresh context for capture. */
export async function launchBrowser(opts: { headed: boolean }): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: !opts.headed,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|please run|install/i.test(message)) {
      throw new Error(
        "Playwright's Chromium is not installed. Run `npx playwright install chromium` " +
          "and try again.\n(Original error: " + message.split("\n")[0] + ")",
      );
    }
    throw err;
  }
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    serviceWorkers: "block", // capture raw API traffic, not SW-cached responses
  });
  context.setDefaultNavigationTimeout(30_000);
  context.setDefaultTimeout(15_000);

  return {
    browser,
    context,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
