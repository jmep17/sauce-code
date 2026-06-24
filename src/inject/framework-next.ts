import path from "node:path";
import fg from "fast-glob";
import { fs, pathExists, writeFile } from "../util/fs.js";

const MARK = "sauce-code:mock-bootstrap";

/**
 * Inject the mock bootstrap into a Next.js app (best-effort).
 *
 * App Router: add a `SauceMockProvider` client component and render it inside
 * app/layout. Pages Router: import + call in _app. Only client-side fetches are
 * mocked by the browser worker; server-side fetches in RSC/route handlers are
 * not (documented limitation).
 */
export async function injectNext(appDir: string, mocksDirRel: string): Promise<string> {
  // Write the client provider next to the mocks.
  const providerPath = path.join(appDir, mocksDirRel, "MockProvider.tsx");
  await writeFile(providerPath, providerSource());

  // App Router layout?
  const layouts = await fg(["app/layout.tsx", "app/layout.jsx", "src/app/layout.tsx", "src/app/layout.jsx"], {
    cwd: appDir,
    absolute: true,
  });
  if (layouts.length) {
    return injectIntoLayout(layouts[0]!, appDir, mocksDirRel);
  }

  // Pages Router _app?
  const apps = await fg(["pages/_app.tsx", "pages/_app.jsx", "src/pages/_app.tsx", "src/pages/_app.jsx"], {
    cwd: appDir,
    absolute: true,
  });
  if (apps.length) {
    return injectIntoApp(apps[0]!, appDir, mocksDirRel);
  }

  throw new Error("Could not locate a Next.js layout or _app to inject into");
}

async function injectIntoLayout(file: string, appDir: string, mocksDirRel: string): Promise<string> {
  let src = await fs.readFile(file, "utf8");
  if (src.includes(MARK)) return file;
  const importPath = relImport(file, appDir, mocksDirRel, "MockProvider");
  const importLine = `import { SauceMockProvider } from "${importPath}"; // ${MARK}`;

  src = `${importLine}\n${src}`;
  // Wrap children with the provider: insert provider right after the opening body tag.
  if (/<body[^>]*>/.test(src)) {
    src = src.replace(/(<body[^>]*>)/, `$1\n        <SauceMockProvider />`);
  } else {
    // Fallback: render before {children}.
    src = src.replace(/\{\s*children\s*\}/, `<SauceMockProvider />{children}`);
  }
  await fs.writeFile(file, src, "utf8");
  return file;
}

async function injectIntoApp(file: string, appDir: string, mocksDirRel: string): Promise<string> {
  let src = await fs.readFile(file, "utf8");
  if (src.includes(MARK)) return file;
  const importPath = relImport(file, appDir, mocksDirRel, "start");
  const importLine = `import { startMocks } from "${importPath}"; // ${MARK}`;
  src = `${importLine}\nif (typeof window !== "undefined") { void startMocks(); }\n${src}`;
  await fs.writeFile(file, src, "utf8");
  return file;
}

function relImport(fromFile: string, appDir: string, mocksDirRel: string, name: string): string {
  const target = path.join(appDir, mocksDirRel, name);
  let rel = path.relative(path.dirname(fromFile), target).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function providerSource(): string {
  return `"use client";
// ${MARK}
import { useEffect } from "react";
import { startMocks } from "./start";

export function SauceMockProvider() {
  useEffect(() => {
    void startMocks();
  }, []);
  return null;
}
`;
}

export { pathExists };
