import path from "node:path";
import { fs, pathExists } from "../util/fs.js";

const MARK_START = "<!-- sauce-code:mock-bootstrap:start -->";
const MARK_END = "<!-- sauce-code:mock-bootstrap:end -->";

/**
 * Inject the mock bootstrap into a Vite app's index.html.
 *
 * We add a `<script type="module">` BEFORE the app's entry script. Module
 * scripts execute in document order, and a module with top-level await blocks
 * subsequent module scripts — so awaiting `startMocks()` here guarantees the
 * service worker is registered before the app makes its first request. Vite
 * transforms TS module scripts referenced from index.html, so `/mocks/auto.ts`
 * resolves and runs.
 */
export async function injectVite(appDir: string, mocksDirRel: string): Promise<string> {
  const indexHtml = path.join(appDir, "index.html");
  if (!(await pathExists(indexHtml))) {
    throw new Error(`Vite index.html not found at ${indexHtml}`);
  }
  let html = await fs.readFile(indexHtml, "utf8");

  // Idempotent: strip any previous injection.
  html = stripInjection(html);

  const snippet = `${MARK_START}\n    <script type="module" src="/${mocksDirRel}/auto.ts"></script>\n    ${MARK_END}`;

  // Insert just before the first app module script if present, else before </head>.
  const scriptRe = /<script\s+type="module"[^>]*src=/i;
  const match = html.match(scriptRe);
  if (match && match.index !== undefined) {
    const insertAt = html.lastIndexOf("<", match.index) === match.index
      ? match.index
      : match.index;
    html = html.slice(0, insertAt) + snippet + "\n    " + html.slice(insertAt);
  } else if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `  ${snippet}\n  </head>`);
  } else if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/(<body[^>]*>)/i, `$1\n    ${snippet}`);
  } else {
    html = `${snippet}\n${html}`;
  }

  await fs.writeFile(indexHtml, html, "utf8");
  return indexHtml;
}

export function stripInjection(html: string): string {
  const re = new RegExp(`\\s*${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}`, "g");
  return html.replace(re, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
