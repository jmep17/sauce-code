import path from "node:path";
import { run, runSafe } from "../util/exec.js";
import { ensureDir, isDirectory, pathExists } from "../util/fs.js";

export interface WorktreeResult {
  /** Absolute path to the created (or reused) worktree. */
  dir: string;
  reused: boolean;
}

/**
 * Add a git worktree for `branch` at `dest`, off the repo at `gitDir`.
 *
 * Reuses an existing worktree directory if present. For branches that only
 * exist on a remote (common with mirror clones), creates a local tracking
 * branch from origin/<branch> as needed.
 */
export async function addWorktree(
  gitDir: string,
  branch: string,
  dest: string,
): Promise<WorktreeResult> {
  await ensureDir(path.dirname(dest));

  if (await isDirectory(dest)) {
    if (await pathExists(path.join(dest, ".git"))) {
      return { dir: dest, reused: true };
    }
    throw new Error(`Destination exists but is not a worktree: ${dest}`);
  }

  // Prefer an existing local branch / commit-ish.
  const direct = await runSafe("git", [
    "-C",
    gitDir,
    "worktree",
    "add",
    dest,
    branch,
  ]);
  if (direct.exitCode === 0) return { dir: dest, reused: false };

  // Fall back to creating a local branch tracking origin/<branch> (mirror case).
  const tracking = await runSafe("git", [
    "-C",
    gitDir,
    "worktree",
    "add",
    "-b",
    branch,
    dest,
    `origin/${branch}`,
  ]);
  if (tracking.exitCode === 0) return { dir: dest, reused: false };

  // Last resort: a DETACHED worktree at the branch tip. This handles the common
  // case where the branch is already checked out in the source repo (git forbids
  // checking out the same branch in two worktrees). A detached worktree has the
  // same files, which is all we need to run + capture the app.
  for (const ref of [branch, `origin/${branch}`]) {
    const detached = await runSafe("git", [
      "-C",
      gitDir,
      "worktree",
      "add",
      "--detach",
      dest,
      ref,
    ]);
    if (detached.exitCode === 0) return { dir: dest, reused: false };
  }

  throw new Error(
    `git worktree add failed for branch "${branch}":\n${direct.stderr || tracking.stderr}`,
  );
}

/** Remove a worktree (used for cleanup when --keep is not set). */
export async function removeWorktree(gitDir: string, dest: string): Promise<void> {
  await runSafe("git", ["-C", gitDir, "worktree", "remove", "--force", dest]);
}
