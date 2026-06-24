import { execa } from "execa";
import type { PmCommands } from "../detect/packageManager.js";

/** Install dependencies in the app directory using the detected package manager. */
export async function installDeps(
  appDir: string,
  pm: PmCommands,
  onLine?: (line: string) => void,
): Promise<void> {
  const proc = execa(pm.pm, pm.install, {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1", ADBLOCK: "1" },
  });

  const pipe = (stream: NodeJS.ReadableStream | null) => {
    if (!stream || !onLine) return;
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    });
  };
  pipe(proc.stdout);
  pipe(proc.stderr);

  await proc;
}
