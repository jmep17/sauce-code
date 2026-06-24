import path from "node:path";
import fg from "fast-glob";
import dotenv from "dotenv";
import { fs } from "../util/fs.js";
import { allDeps, type PackageJson } from "./packageJson.js";

export type AuthFlavor = "auth0-spa" | "auth0-next" | "none";

export interface AuthInfo {
  flavor: AuthFlavor;
  domain?: string;
  clientId?: string;
  audience?: string;
  /** Configured callback/redirect URL, if discoverable from env. */
  callbackUrl?: string;
  /** The raw env keys we matched, for diagnostics. */
  matchedKeys: string[];
}

/**
 * Detect Auth0 usage from dependencies and parse `.env*` files for the tenant
 * configuration. We never load these values into our own process — we only
 * read them to build a faithful fake session.
 */
export async function detectAuth(appDir: string, pkg: PackageJson): Promise<AuthInfo> {
  const deps = allDeps(pkg);
  let flavor: AuthFlavor = "none";
  if (deps["@auth0/nextjs-auth0"]) flavor = "auth0-next";
  else if (deps["@auth0/auth0-react"] || deps["@auth0/auth0-spa-js"]) flavor = "auth0-spa";

  const env = await loadEnvFiles(appDir);
  const matchedKeys: string[] = [];
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const direct = env[n];
      if (direct) {
        matchedKeys.push(n);
        return direct;
      }
    }
    // Prefixed variants (VITE_, NEXT_PUBLIC_, REACT_APP_, PUBLIC_).
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;
      const bare = key.replace(/^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_)/, "");
      if (names.includes(bare)) {
        matchedKeys.push(key);
        return value;
      }
    }
    return undefined;
  };

  let domain = pick("AUTH0_DOMAIN", "AUTH0_ISSUER_BASE_URL");
  if (domain) domain = normalizeDomain(domain);

  const clientId = pick("AUTH0_CLIENT_ID");
  const audience = pick("AUTH0_AUDIENCE");
  const callbackUrl = pick("AUTH0_CALLBACK_URL", "AUTH0_BASE_URL", "AUTH0_REDIRECT_URI");

  return { flavor, domain, clientId, audience, callbackUrl, matchedKeys };
}

function normalizeDomain(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function loadEnvFiles(appDir: string): Promise<Record<string, string>> {
  const files = await fg([".env", ".env.*"], {
    cwd: appDir,
    dot: true,
    onlyFiles: true,
    absolute: true,
  });
  // Later files override earlier; load base first, then specific.
  files.sort((a, b) => a.length - b.length);
  const merged: Record<string, string> = {};
  for (const file of files) {
    if (file.endsWith(".example") || file.endsWith(".sample")) continue;
    try {
      const parsed = dotenv.parse(await fs.readFile(file, "utf8"));
      Object.assign(merged, parsed);
    } catch {
      /* ignore unreadable env file */
    }
  }
  return merged;
}
