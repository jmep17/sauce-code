import path from "node:path";
import { pathExists } from "../util/fs.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PmCommands {
  pm: PackageManager;
  install: string[];
  /** Build a "run <script>" invocation with optional extra args. */
  run: (script: string, extra?: string[]) => { command: string; args: string[] };
  /** Build an "exec <bin>" invocation (npx-equivalent). */
  exec: (bin: string, args: string[]) => { command: string; args: string[] };
  /** Build an "add dev dependency" invocation. */
  addDev: (pkgs: string[]) => { command: string; args: string[] };
}

/** Detect the package manager from lockfiles in the app directory. */
export async function detectPackageManager(appDir: string): Promise<PmCommands> {
  let pm: PackageManager = "npm";
  if (await pathExists(path.join(appDir, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (await pathExists(path.join(appDir, "bun.lockb"))) pm = "bun";
  else if (await pathExists(path.join(appDir, "yarn.lock"))) pm = "yarn";
  else if (await pathExists(path.join(appDir, "package-lock.json"))) pm = "npm";

  return buildCommands(pm);
}

function buildCommands(pm: PackageManager): PmCommands {
  switch (pm) {
    case "pnpm":
      return {
        pm,
        install: ["install"],
        run: (script, extra = []) => ({
          command: "pnpm",
          args: ["run", script, ...extra],
        }),
        exec: (bin, args) => ({ command: "pnpm", args: ["exec", bin, ...args] }),
        addDev: (pkgs) => ({ command: "pnpm", args: ["add", "-D", ...pkgs] }),
      };
    case "yarn":
      return {
        pm,
        install: ["install"],
        run: (script, extra = []) => ({
          command: "yarn",
          args: [script, ...extra],
        }),
        exec: (bin, args) => ({ command: "yarn", args: ["exec", bin, ...args] }),
        addDev: (pkgs) => ({ command: "yarn", args: ["add", "-D", ...pkgs] }),
      };
    case "bun":
      return {
        pm,
        install: ["install"],
        run: (script, extra = []) => ({
          command: "bun",
          args: ["run", script, ...extra],
        }),
        exec: (bin, args) => ({ command: "bunx", args: [bin, ...args] }),
        addDev: (pkgs) => ({ command: "bun", args: ["add", "-d", ...pkgs] }),
      };
    case "npm":
    default:
      return {
        pm: "npm",
        install: ["install"],
        run: (script, extra = []) => ({
          command: "npm",
          args: extra.length ? ["run", script, "--", ...extra] : ["run", script],
        }),
        exec: (bin, args) => ({ command: "npx", args: ["--yes", bin, ...args] }),
        addDev: (pkgs) => ({ command: "npm", args: ["install", "-D", ...pkgs] }),
      };
  }
}
