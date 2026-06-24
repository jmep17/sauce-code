import { runSafe } from "../util/exec.js";

export interface GhRepo {
  /** "owner/name" — used as the autocomplete label. */
  nameWithOwner: string;
  /** HTTPS clone URL (what we hand to the remote clone path). */
  cloneUrl: string;
  /** SSH clone URL (kept for reference / future use). */
  sshUrl: string;
  /** Repo description, or null when unset. */
  description: string | null;
  isPrivate: boolean;
}

/**
 * True when the GitHub CLI is installed and authenticated. `runSafe` swallows
 * a missing `gh` binary (spawn error → non-zero), so a false return covers both
 * "not installed" and "not logged in".
 */
export async function ghReady(): Promise<boolean> {
  const res = await runSafe("gh", ["auth", "status"]);
  return res.exitCode === 0;
}

/** The active gh OAuth token, used to authenticate private github.com clones. */
export async function ghToken(): Promise<string | undefined> {
  const res = await runSafe("gh", ["auth", "token"]);
  const token = res.stdout.trim();
  return res.exitCode === 0 && token ? token : undefined;
}

/**
 * List every repository the authenticated user can access (owned, collaborator,
 * and organization-member), most-recently-pushed first.
 *
 * Uses `gh api --paginate` rather than `gh repo list` because the latter omits
 * org/collaborator repos. With `--jq` applied per page, `--paginate` streams one
 * JSON object per line (NDJSON), which we parse line-by-line.
 */
export async function listAccessibleRepos(): Promise<GhRepo[]> {
  const res = await runSafe("gh", [
    "api",
    "--paginate",
    "-X",
    "GET",
    "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
    "--jq",
    ".[] | {nameWithOwner: .full_name, cloneUrl: .clone_url, sshUrl: .ssh_url, description: .description, isPrivate: .private}",
  ]);
  if (res.exitCode !== 0) return [];

  const repos: GhRepo[] = [];
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      repos.push(JSON.parse(trimmed) as GhRepo);
    } catch {
      // Skip any malformed line rather than failing the whole picker.
    }
  }
  return repos;
}
