import path from "node:path";
import { fs, pathExists } from "../util/fs.js";
import { allDeps, type PackageJson } from "./packageJson.js";

export type FrameworkName =
  | "next"
  | "vite"
  | "astro"
  | "sveltekit"
  | "remix"
  | "cra"
  | "unknown";

export interface FrameworkInfo {
  name: FrameworkName;
  /** Display label. */
  label: string;
  /** npm script to run for dev (verified to exist in package.json). */
  devScript: string;
  /** Default dev port for the framework. */
  defaultPort: number;
  /** Port read from a config file, if any (overrides default). */
  configPort?: number;
  /** Public/static dir served at the web root (for the service worker). */
  publicDir: string;
}

interface FrameworkSpec {
  name: FrameworkName;
  label: string;
  deps: string[];
  configFiles: string[];
  defaultPort: number;
  publicDir: string;
}

const SPECS: FrameworkSpec[] = [
  {
    name: "next",
    label: "Next.js",
    deps: ["next"],
    configFiles: ["next.config.js", "next.config.mjs", "next.config.ts"],
    defaultPort: 3000,
    publicDir: "public",
  },
  {
    name: "remix",
    label: "Remix",
    deps: ["@remix-run/dev", "@remix-run/react"],
    configFiles: ["remix.config.js", "vite.config.ts"],
    defaultPort: 3000,
    publicDir: "public",
  },
  {
    name: "sveltekit",
    label: "SvelteKit",
    deps: ["@sveltejs/kit"],
    configFiles: ["svelte.config.js", "vite.config.ts"],
    defaultPort: 5173,
    publicDir: "static",
  },
  {
    name: "astro",
    label: "Astro",
    deps: ["astro"],
    configFiles: ["astro.config.mjs", "astro.config.ts", "astro.config.js"],
    defaultPort: 4321,
    publicDir: "public",
  },
  {
    name: "vite",
    label: "Vite",
    deps: ["vite"],
    configFiles: ["vite.config.ts", "vite.config.js", "vite.config.mjs"],
    defaultPort: 5173,
    publicDir: "public",
  },
  {
    name: "cra",
    label: "Create React App",
    deps: ["react-scripts"],
    configFiles: [],
    defaultPort: 3000,
    publicDir: "public",
  },
];

/** Detect the web framework, its dev script, and dev port. */
export async function detectFramework(
  appDir: string,
  pkg: PackageJson,
): Promise<FrameworkInfo> {
  const deps = allDeps(pkg);
  const scripts = pkg.scripts ?? {};

  const spec =
    SPECS.find((s) => s.deps.some((d) => deps[d])) ??
    ({
      name: "unknown",
      label: "Unknown",
      deps: [],
      configFiles: [],
      defaultPort: 3000,
      publicDir: "public",
    } satisfies FrameworkSpec);

  const devScript = pickDevScript(scripts, spec.name);
  const configPort = await readConfigPort(appDir, spec.configFiles);

  return {
    name: spec.name,
    label: spec.label,
    devScript,
    defaultPort: spec.defaultPort,
    configPort,
    publicDir: spec.publicDir,
  };
}

function pickDevScript(scripts: Record<string, string>, name: FrameworkName): string {
  // Prefer an explicit dev script; fall back to start/develop.
  if (scripts.dev) return "dev";
  if (name === "cra" && scripts.start) return "start";
  if (scripts.start) return "start";
  if (scripts.develop) return "develop";
  throw new Error(
    `No dev/start script found. Available scripts: ${Object.keys(scripts).join(", ") || "(none)"}`,
  );
}

/**
 * Best-effort port extraction from a config file without executing it.
 * Looks for `port: <number>` (under a server block for Vite/Astro).
 */
async function readConfigPort(
  appDir: string,
  configFiles: string[],
): Promise<number | undefined> {
  for (const file of configFiles) {
    const full = path.join(appDir, file);
    if (!(await pathExists(full))) continue;
    try {
      const text = await fs.readFile(full, "utf8");
      const match = text.match(/port\s*:\s*(\d{2,5})/);
      if (match) return Number(match[1]);
    } catch {
      /* ignore unreadable config */
    }
  }
  return undefined;
}

/** Extra CLI args to pin a dev port, when the framework supports it. */
export function portFlag(name: FrameworkName, port: number): string[] {
  switch (name) {
    case "next":
    case "remix":
      return ["-p", String(port)];
    case "vite":
    case "astro":
    case "sveltekit":
      return ["--port", String(port)];
    case "cra":
      return []; // CRA reads PORT from env instead
    default:
      return [];
  }
}
