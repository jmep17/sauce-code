import path from "node:path";
import { run, runSafe } from "../util/exec.js";
import { ensureDir, isDirectory, slugify } from "../util/fs.js";

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

  if (await isDirectory(gitDir)) {
    // Refresh existing mirror; tolerate transient network failures.
    const res = await runSafe("git", ["-C", gitDir, "remote", "update", "--prune"]);
    if (res.exitCode !== 0) {
      // Keep going with the possibly-stale mirror rather than hard-failing.
    }
    return gitDir;
  }

  await run("git", ["clone", "--mirror", url, gitDir]);
  return gitDir;
}

/** Path to a local repo's git dir (the repo root works for `git -C`). */
export function localGitDir(repoPath: string): string {
  return repoPath;
}
