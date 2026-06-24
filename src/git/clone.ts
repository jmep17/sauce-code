import path from "node:path";
import { run, runSafe } from "../util/exec.js";
import { ensureDir, isDirectory, slugify } from "../util/fs.js";
import { ghToken } from "./gh.js";

/**
 * Ensure a local mirror clone of a remote URL exists in the cache and is
 * up to date. Returns the git directory path of the mirror.
 *
 * A `--mirror` clone is bare and cheap to list branches from and to add
 * worktrees off of.
 */
export async function ensureMirror(
  url: string,
  cacheDir: string,
): Promise<string> {
  await ensureDir(cacheDir);
  const gitDir = path.join(cacheDir, `${slugify(url)}.git`);
  const cred = await githubCredential(url);

  if (await isDirectory(gitDir)) {
    // Refresh existing mirror; tolerate transient network failures.
    const res = await runSafe(
      "git",
      [...cred.args, "-C", gitDir, "remote", "update", "--prune"],
      cred.options,
    );
    if (res.exitCode !== 0) {
      // Keep going with the possibly-stale mirror rather than hard-failing.
    }
    return gitDir;
  }

  await run("git", [...cred.args, "clone", "--mirror", url, gitDir], cred.options);
  return gitDir;
}

/**
 * Build git credential args for a private github.com HTTPS clone.
 *
 * Most users have not run `gh auth setup-git`, so a plain `git clone` of a
 * private repo can't authenticate. When a gh token is available we supply it
 * via an inline credential helper. The token value is passed through the
 * environment (never in argv or persisted to `.git/config`); the leading empty
 * `credential.helper=` resets any inherited helper (e.g. osxkeychain) so only
 * ours runs. Non-github / SSH / token-absent URLs get no extra args.
 */
async function githubCredential(
  url: string,
): Promise<{ args: string[]; options: { env?: Record<string, string> } }> {
  if (!/^https:\/\/github\.com\//i.test(url)) return { args: [], options: {} };
  const token = await ghToken();
  if (!token) return { args: [], options: {} };

  const helper =
    '!f() { test "$1" = get && echo username=x-access-token && echo "password=$SAUCE_GH_TOKEN"; }; f';
  return {
    args: ["-c", "credential.helper=", "-c", `credential.helper=${helper}`],
    options: { env: { SAUCE_GH_TOKEN: token } },
  };
}

/** Path to a local repo's git dir (the repo root works for `git -C`). */
export function localGitDir(repoPath: string): string {
  return repoPath;
}
