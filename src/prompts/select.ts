import path from "node:path";
import * as p from "@clack/prompts";
import { isDirectory, pathExists } from "../util/fs.js";
import { ghReady, listAccessibleRepos } from "../git/gh.js";

export interface RepoSource {
  kind: "local" | "remote";
  /** Absolute path for local, URL for remote. */
  value: string;
}

function looksLikeGitUrl(value: string): boolean {
  return (
    /^https?:\/\//.test(value) ||
    /^git@/.test(value) ||
    /^ssh:\/\//.test(value) ||
    value.endsWith(".git")
  );
}

/** Interactively choose a GitHub repo, a local path, or a remote git URL. */
export async function selectRepoSource(preset?: string): Promise<RepoSource> {
  if (preset) {
    return resolveSource(preset);
  }

  const hasGh = await ghReady();
  const options = [
    ...(hasGh
      ? [
          {
            value: "github" as const,
            label: "GitHub repo",
            hint: "search repos you can access",
          },
        ]
      : []),
    { value: "local" as const, label: "Local path", hint: "a git repo on this machine" },
    { value: "remote" as const, label: "Remote URL", hint: "clone from a git URL" },
  ];

  const kind = await p.select({ message: "Where is the repository?", options });
  if (p.isCancel(kind)) cancel();

  if (kind === "github") {
    return pickGithubRepo();
  }

  if (kind === "local") {
    const input = await p.text({
      message: "Path to the local repository",
      placeholder: process.cwd(),
      validate: (v) => (v?.trim() ? undefined : "Path is required"),
    });
    if (p.isCancel(input)) cancel();
    return resolveSource(input as string);
  }

  return promptRemoteUrl();
}

/** Fetch the user's accessible repos via gh and pick one with a search box. */
async function pickGithubRepo(): Promise<RepoSource> {
  const s = p.spinner();
  s.start("Fetching repositories");
  const repos = await listAccessibleRepos();
  s.stop(`Found ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`);

  if (repos.length === 0) {
    p.log.warn("No repositories returned by gh — enter a URL instead.");
    return promptRemoteUrl();
  }

  const choice = await p.autocomplete({
    message: "Pick a repository",
    placeholder: "Type to search…",
    maxItems: 10,
    options: repos.map((r) => ({
      value: r.cloneUrl,
      label: r.nameWithOwner,
      hint: r.isPrivate ? "private" : r.description ?? "public",
    })),
  });
  if (p.isCancel(choice)) cancel();
  return { kind: "remote", value: choice as string };
}

/** Free-text prompt for a remote git URL (also the gh-unavailable fallback). */
async function promptRemoteUrl(): Promise<RepoSource> {
  const url = await p.text({
    message: "Git URL to clone",
    placeholder: "https://github.com/owner/repo.git",
    validate: (v) =>
      looksLikeGitUrl((v ?? "").trim()) ? undefined : "Does not look like a git URL",
  });
  if (p.isCancel(url)) cancel();
  return { kind: "remote", value: (url as string).trim() };
}

async function resolveSource(value: string): Promise<RepoSource> {
  const trimmed = value.trim();
  if (looksLikeGitUrl(trimmed) && !(await pathExists(trimmed))) {
    return { kind: "remote", value: trimmed };
  }
  const abs = path.resolve(trimmed);
  if (!(await isDirectory(abs))) {
    throw new Error(`Not a directory: ${abs}`);
  }
  if (!(await isDirectory(path.join(abs, ".git")))) {
    // Allow bare/worktree dirs too, but warn the caller via the git layer.
    if (!(await pathExists(path.join(abs, ".git")))) {
      throw new Error(`Not a git repository (no .git): ${abs}`);
    }
  }
  return { kind: "local", value: abs };
}

/** Interactively pick a branch from the candidate list with a search box. */
export async function selectBranch(
  branches: string[],
  current?: string,
  preset?: string,
): Promise<string> {
  if (preset) {
    if (branches.length && !branches.includes(preset)) {
      throw new Error(
        `Branch "${preset}" not found. Available: ${branches.join(", ")}`,
      );
    }
    return preset;
  }
  if (branches.length === 0) {
    throw new Error("No branches found in the repository.");
  }
  if (branches.length === 1) return branches[0]!;

  const initial = current && branches.includes(current) ? current : branches[0];
  const choice = await p.autocomplete({
    message: "Which branch?",
    placeholder: "Type to filter…",
    maxItems: 10,
    initialValue: initial,
    options: branches.map((b) => ({
      value: b,
      label: b === current ? `${b} (current)` : b,
    })),
  });
  if (p.isCancel(choice)) cancel();
  return choice as string;
}

function cancel(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}
