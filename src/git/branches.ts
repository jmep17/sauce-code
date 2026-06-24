import { run, runSafe } from "../util/exec.js";

export interface BranchInfo {
  /** Branch name without refs/heads or remote prefix (e.g. "main"). */
  name: string;
  isCurrent: boolean;
}

/**
 * List selectable branches for a repo.
 *
 * For a mirror clone, branches live under refs/heads. For a regular working
 * repo we list local heads plus remote-tracking branches (deduped by short
 * name), so the user can pick a branch that only exists on origin.
 */
export async function listBranches(gitDir: string): Promise<{
  branches: string[];
  current?: string;
}> {
  const current = await currentBranch(gitDir);

  const localOut = await run("git", [
    "-C",
    gitDir,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  const locals = splitLines(localOut);

  const remoteOut = await runSafe("git", [
    "-C",
    gitDir,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes",
  ]);
  const remotes = splitLines(remoteOut.stdout)
    .map((r) => r.replace(/^[^/]+\//, "")) // drop "origin/"
    .filter((r) => r && r !== "HEAD");

  const set = new Set<string>([...locals, ...remotes]);
  const branches = [...set].sort((a, b) => {
    if (a === current) return -1;
    if (b === current) return 1;
    return a.localeCompare(b);
  });

  return { branches, current };
}

async function currentBranch(gitDir: string): Promise<string | undefined> {
  const res = await runSafe("git", [
    "-C",
    gitDir,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const name = res.stdout.trim();
  return res.exitCode === 0 && name ? name : undefined;
}

function splitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
