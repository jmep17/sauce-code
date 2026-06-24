import { promises as fs } from "node:fs";
import path from "node:path";

/** Slugify a repo/branch identifier into a filesystem-safe string. */
export function slugify(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase()
    .slice(0, 120);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

export async function readJsonIfExists<T = unknown>(
  file: string,
): Promise<T | undefined> {
  if (!(await pathExists(file))) return undefined;
  try {
    return await readJson<T>(file);
  } catch {
    return undefined;
  }
}

export async function writeFile(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, "utf8");
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

export async function writeBuffer(file: string, buf: Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, buf);
}

export { fs };
