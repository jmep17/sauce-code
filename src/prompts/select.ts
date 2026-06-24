import path from "node:path";
import * as p from "@clack/prompts";
import { isDirectory, pathExists } from "../util/fs.js";

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

/** Interactively choose a local repo path or a remote git URL. */
export async function selectRepoSource(preset?: string): Promise<RepoSource> {
  if (preset) {
    return resolveSource(preset);
  }

  const kind = await p.select({
    message: "Where is the repository?",
    options: [
      { value: "local", label: "Local path", hint: "a git repo on this machine" },
      { value: "remote", label: "Remote URL", hint: "clone from a git URL" },
    ],
  });
  if (p.isCancel(kind)) cancel();

  if (kind === "local") {
    const input = await p.text({
      message: "Path to the local repository",
      placeholder: process.cwd(),
      validate: (v) => (v.trim() ? undefined : "Path is required"),
    });
    if (p.isCancel(input)) cancel();
    return resolveSource(input as string);
  }

  const url = await p.text({
    message: "Git URL to clone",
    placeholder: "https://github.com/owner/repo.git",
    validate: (v) =>
      looksLikeGitUrl(v.trim()) ? undefined : "Does not look like a git URL",
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

/** Interactively pick a branch from the candidate list. */
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
  const choice = await p.select({
    message: "Which branch?",
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
