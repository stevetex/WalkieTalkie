// Runs the relay perf scenarios and writes perf-results.json.
//
//   node perf/run.ts [--suite quick|full] [--relay-dir <server dir>] [--label head|base]
//                    [--out perf-results.json] [--only A,B] [--check]
//
// --relay-dir tests another checkout's relay (the base commit's worktree in CI) with this
// checkout's scenarios and bots. quick = the scenarios with no simulated delay (what CI runs
// for base vs head, several rounds); full = everything, including the simulated network and
// the load test. --check judges the results against perf/budgets.json (compare.ts) and exits
// 1 on a failure. `npm run perf` is `--suite full --check`.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Results, type Context } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "quick" },
    "relay-dir": { type: "string", default: resolve(here, "..") },
    label: { type: "string", default: "head" },
    out: { type: "string", default: "perf-results.json" },
    only: { type: "string" },
    check: { type: "boolean", default: false },
  },
});

const suite = values.suite === "full" ? "full" : "quick";
const relayDir = resolve(values["relay-dir"]!);

interface Scenario {
  name: string;
  run(ctx: Context): Promise<void>;
  fullOnly?: boolean;
}

const scenarios: Array<[string, Scenario]> = [
  ["A", await import("./scenarios/a-ring-to-start.ts")],
  ["B", await import("./scenarios/b-live.ts")],
  ["C", await import("./scenarios/c-back-and-forth.ts")],
  ["D", await import("./scenarios/d-http-sender.ts")],
  ["E", await import("./scenarios/e-first-press.ts")],
  ["F", await import("./scenarios/f-unanswered.ts")],
  ["G", await import("./scenarios/g-codecs.ts")],
  ["H", await import("./scenarios/h-load.ts")],
  ["I", await import("./scenarios/i-encrypted.ts")],
];

export interface RunResults {
  schema: 1;
  label: string;
  suite: "quick" | "full";
  commit: string;
  relayCommit: string;
  branch: string;
  date: string;
  runner: { os: string; arch: string; cpus: number; cpuModel: string; node: string };
  durationMs: number;
  metrics: Results["metrics"];
  errors: string[];
}

const git = (dir: string, ...args: string[]): string => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const results = new Results();
const only = values.only?.split(",").map((s) => s.trim().toUpperCase());
const started = performance.now();
for (const [letter, scenario] of scenarios) {
  if (only && !only.includes(letter)) continue;
  if (scenario.fullOnly && suite !== "full") continue;
  const t0 = performance.now();
  try {
    await scenario.run({ relayDir, suite, results });
  } catch (err) {
    results.fail(`${letter}.crashed`, [(err as Error).stack ?? String(err)]);
  }
  console.error(`${scenario.name}: ${Math.round(performance.now() - t0)} ms`);
}

const output: RunResults = {
  schema: 1,
  label: values.label!,
  suite,
  commit: process.env.GITHUB_SHA ?? git(here, "rev-parse", "HEAD"),
  relayCommit: git(relayDir, "rev-parse", "HEAD"),
  branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git(here, "rev-parse", "--abbrev-ref", "HEAD"),
  date: new Date().toISOString(),
  runner: { os: `${platform()}`, arch: arch(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? "", node: process.version },
  durationMs: Math.round(performance.now() - started),
  metrics: results.metrics,
  errors: results.errors,
};
mkdirSync(dirname(resolve(values.out!)), { recursive: true });
writeFileSync(values.out!, JSON.stringify(output, null, 2) + "\n");

const width = Math.max(...Object.keys(output.metrics).map((k) => k.length));
for (const [key, m] of Object.entries(output.metrics)) {
  console.log(`${key.padEnd(width)}  ${String(m.median).padStart(9)} ${m.unit.padEnd(11)} p95 ${String(m.p95).padStart(9)}  n=${m.n}  ${m.kind}`);
}
for (const e of output.errors) console.log(`! ${e}`);
console.log(`\n${Object.keys(output.metrics).length} metrics in ${(output.durationMs / 1000).toFixed(1)} s → ${values.out}`);

if (values.check) {
  const { checkAgainstBudgets } = await import("./compare.ts");
  process.exitCode = checkAgainstBudgets(output) ? 0 : 1;
}
// The bots' sockets can hold the loop open after a failure; the results are written.
process.exit(process.exitCode ?? 0);
