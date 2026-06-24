import path from "node:path";
import fg from "fast-glob";
import { pathExists, readJsonIfExists } from "../util/fs.js";

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  [key: string]: unknown;
}

export interface AppLocation {
  /** Directory containing the app's package.json. */
  dir: string;
  pkg: PackageJson;
}

export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  return readJsonIfExists<PackageJson>(path.join(dir, "package.json"));
}

export function allDeps(pkg: PackageJson): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function hasDevScript(pkg: PackageJson | undefined): boolean {
  const scripts = pkg?.scripts ?? {};
  return Boolean(scripts.dev || scripts.start || scripts.develop);
}

/**
 * Find the actual app directory inside a worktree. Usually the root, but for a
 * monorepo whose root has no dev script, we search workspace packages and pick
 * the first one that has a dev/start script and a known framework dependency.
 */
export async function findAppDir(worktree: string): Promise<AppLocation> {
  const rootPkg = await readPackageJson(worktree);
  if (rootPkg && hasDevScript(rootPkg)) {
    return { dir: worktree, pkg: rootPkg };
  }

  // Resolve workspace globs (package.json workspaces or common monorepo dirs).
  const patterns = workspacePatterns(rootPkg);
  const candidates = await fg(patterns, {
    cwd: worktree,
    onlyFiles: true,
    absolute: true,
    ignore: ["**/node_modules/**"],
    deep: 4,
  });

  const located: AppLocation[] = [];
  for (const pkgPath of candidates) {
    const dir = path.dirname(pkgPath);
    const pkg = await readPackageJson(dir);
    if (pkg && hasDevScript(pkg)) located.push({ dir, pkg });
  }

  // Prefer a package that depends on a known web framework.
  const FRAMEWORK_HINTS = ["next", "vite", "astro", "@sveltejs/kit", "@remix-run/dev", "react-scripts"];
  const framed = located.find((l) => {
    const deps = allDeps(l.pkg);
    return FRAMEWORK_HINTS.some((h) => deps[h]);
  });
  if (framed) return framed;
  if (located.length) return located[0]!;

  if (rootPkg) return { dir: worktree, pkg: rootPkg };
  throw new Error(`No package.json with a dev/start script found under ${worktree}`);
}

function workspacePatterns(pkg: PackageJson | undefined): string[] {
  const fromField: string[] = Array.isArray(pkg?.workspaces)
    ? pkg!.workspaces
    : (pkg?.workspaces as { packages?: string[] } | undefined)?.packages ?? [];
  const globs = fromField.map((w) =>
    w.endsWith("/package.json") ? w : `${w.replace(/\/$/, "")}/package.json`,
  );
  // Common conventions as a fallback.
  globs.push("apps/*/package.json", "packages/*/package.json", "examples/*/package.json");
  return [...new Set(globs)];
}

export { pathExists };
