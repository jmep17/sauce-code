import path from "node:path";
import fg from "fast-glob";
import { fs } from "../util/fs.js";

const MARK = "sauce-code:mock-bootstrap";

/**
 * Inject the mock bootstrap into an Astro app (best-effort).
 *
 * Astro processes `<script>` tags in `.astro` files and bundles them as
 * client modules. We add a client script to the most likely base layout (or the
 * index page) that imports and starts the worker.
 */
export async function injectAstro(appDir: string, mocksDirRel: string): Promise<string> {
  const candidates = await fg(
    [
      "src/layouts/*.astro",
      "src/layouts/**/*.astro",
      "src/pages/index.astro",
      "src/pages/**/*.astro",
    ],
    { cwd: appDir, absolute: true },
  );
  if (candidates.length === 0) {
    throw new Error("No .astro layout or page found for injection");
  }
  const file = candidates[0]!;
  let src = await fs.readFile(file, "utf8");
  if (src.includes(MARK)) return file;

  const target = path.join(appDir, mocksDirRel, "start");
  let rel = path.relative(path.dirname(file), target).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;

  const script = `\n<script>\n  // ${MARK}\n  import { startMocks } from "${rel}";\n  startMocks();\n</script>\n`;

  // Append the script at the end of the file (Astro hoists/bundles it).
  src = `${src}\n${script}`;
  await fs.writeFile(file, src, "utf8");
  return file;
}
