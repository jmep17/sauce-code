import process from "node:process";
import { parseArgs } from "node:util";
import { logger, setDebug } from "./logger.js";
import { buildConfig, type CliFlags } from "./config.js";
import { run } from "./pipeline.js";

const HELP = `
sauce-code — run any Vite/Next/Astro app against automatically generated mocks.

Usage:
  sauce-code [options]

Options:
  --repo <path|url>     Local repo path or remote git URL (prompted if omitted)
  --branch <name>       Branch to check out (prompted if omitted)
  --depth <n>           Crawl depth from the entry route (default: 2)
  --max-pages <n>       Max pages to visit while crawling (default: 25)
  --headed              Run the browser visibly (default: headless)
  --keep                Keep the worktree after the run
  --no-relaunch         Only capture + generate mocks; don't relaunch the app
  --debug               Verbose logging (dev server + crawler output)
  -h, --help            Show this help

Examples:
  sauce-code
  sauce-code --repo ./my-app --branch main
  sauce-code --repo https://github.com/owner/app.git --headed --debug
`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        repo: { type: "string" },
        branch: { type: "string" },
        depth: { type: "string" },
        "max-pages": { type: "string" },
        headed: { type: "boolean" },
        keep: { type: "boolean" },
        "no-relaunch": { type: "boolean" },
        debug: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
  } catch (err) {
    logger.error((err as Error).message);
    process.stdout.write(HELP);
    process.exit(2);
  }

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return;
  }

  const flags: CliFlags = {
    repo: parsed.values.repo,
    branch: parsed.values.branch,
    depth: parseIntOpt(parsed.values.depth, "--depth"),
    maxPages: parseIntOpt(parsed.values["max-pages"], "--max-pages"),
    headed: parsed.values.headed,
    keep: parsed.values.keep,
    // parseArgs exposes --no-relaunch as values["no-relaunch"] = true.
    noRelaunch: parsed.values["no-relaunch"],
    debug: parsed.values.debug,
  };

  setDebug(Boolean(flags.debug));
  logger.intro("sauce-code");

  const config = buildConfig(flags, process.cwd());

  try {
    await run(config);
  } catch (err) {
    logger.error((err as Error).message);
    if (flags.debug && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
  }
}

function parseIntOpt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }
  return Math.floor(n);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
