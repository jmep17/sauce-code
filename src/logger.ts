import * as p from "@clack/prompts";
import pc from "picocolors";

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export const logger = {
  intro(message: string): void {
    p.intro(pc.bgCyan(pc.black(` ${message} `)));
  },
  outro(message: string): void {
    p.outro(message);
  },
  step(message: string): void {
    p.log.step(message);
  },
  info(message: string): void {
    p.log.info(message);
  },
  success(message: string): void {
    p.log.success(pc.green(message));
  },
  warn(message: string): void {
    p.log.warn(pc.yellow(message));
  },
  error(message: string): void {
    p.log.error(pc.red(message));
  },
  message(message: string): void {
    p.log.message(message);
  },
  debug(message: string): void {
    if (debugEnabled) p.log.message(pc.dim(`[debug] ${message}`));
  },
  spinner() {
    return p.spinner();
  },
};

export { p as prompts, pc as colors };
