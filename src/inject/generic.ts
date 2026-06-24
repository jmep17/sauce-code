import path from "node:path";
import fg from "fast-glob";
import { fs } from "../util/fs.js";
import { stripInjection } from "./framework-vite.js";

/**
 * Fallback injector for apps with a root index.html but no recognized
 * framework. Same technique as the Vite injector: a module script that awaits
 * startMocks before the app's scripts run.
 */
export async function injectGeneric(appDir: string, mocksDirRel: string): Promise<string> {
  const candidates = await fg(["index.html", "public/index.html", "src/index.html"], {
    cwd: appDir,
    absolute: true,
  });
  if (candidates.length === 0) {
    throw new Error("No index.html found for generic injection");
  }
  const indexHtml = candidates[0]!;
  let html = await fs.readFile(indexHtml, "utf8");
  html = stripInjection(html);

  const snippet = `<!-- sauce-code:mock-bootstrap:start -->\n    <script type="module" src="/${mocksDirRel}/auto.ts"></script>\n    <!-- sauce-code:mock-bootstrap:end -->`;
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `  ${snippet}\n  </head>`);
  } else {
    html = `${snippet}\n${html}`;
  }
  await fs.writeFile(indexHtml, html, "utf8");
  void path;
  return indexHtml;
}
