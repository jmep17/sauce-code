import path from "node:path";

export interface RunConfig {
  /** Local path or remote git URL (resolved interactively if omitted). */
  repo?: string;
  /** Branch to check out (resolved interactively if omitted). */
  branch?: string;
  /** Max crawl depth from the entry route. */
  depth: number;
  /** Max number of pages to visit during the crawl. */
  maxPages: number;
  /** Run the browser headed (visible) instead of headless. */
  headed: boolean;
  /** Keep the worktree after the run instead of leaving it for reuse. */
  keep: boolean;
  /** Skip the mocked relaunch step (only capture + generate). */
  noRelaunch: boolean;
  /** Root of the sauce-code project (where worktrees/.cache/output live). */
  projectRoot: string;
  /** Directory for cached mirror clones of remote repos. */
  cacheDir: string;
  /** Directory holding created worktrees. */
  worktreesDir: string;
  /** Directory holding per-run output artifacts. */
  outputDir: string;
}

export interface CliFlags {
  repo?: string;
  branch?: string;
  depth?: number;
  maxPages?: number;
  headed?: boolean;
  keep?: boolean;
  noRelaunch?: boolean;
  debug?: boolean;
}

export function buildConfig(flags: CliFlags, projectRoot: string): RunConfig {
  return {
    repo: flags.repo,
    branch: flags.branch,
    depth: flags.depth ?? 2,
    maxPages: flags.maxPages ?? 25,
    headed: flags.headed ?? false,
    keep: flags.keep ?? false,
    noRelaunch: flags.noRelaunch ?? false,
    projectRoot,
    cacheDir: path.join(projectRoot, ".cache"),
    worktreesDir: path.join(projectRoot, "worktrees"),
    outputDir: path.join(projectRoot, "output"),
  };
}
