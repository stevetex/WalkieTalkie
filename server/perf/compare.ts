// Judges perf results and writes the job summary.
//
//   node perf/compare.ts [--head-dir dir] [--base-dir dir] [--full file] [--kit-lines file]
//                        [--budgets perf/budgets.json] [--history file.jsonl]
//                        [--append-history out.jsonl] [--summary file.md] [--update-budgets]
//
//   --head-dir, --base-dir  quick-suite results, one file per round, of this commit and the
//                           base commit's relay run in turn on the same runner (pull requests)
//   --full                  this commit's full-suite results
//   --kit-lines             the kit's measurements from `swift test` (OAO_KIT_METRICS), one JSON
//                           object per line: {key, value, unit, kind}
//   --history               earlier main runs, one line each, for drift
//   --append-history        writes --history plus this run's line (main only)
//   --update-budgets        rewrites the budgets from these results (after a deliberate change)
//
// Rules (perf/budgets.json's "enforce" turns warnings into failures once thresholds are tuned):
//   integrity                 fail when > 0, always
//   count, approx             fail over budget, always
//   legs, sim                 over budget: warn, or fail with enforce.network
//   level, quality (kit)      outside budget: warn, or fail with enforce.kit
//   time (base vs head)       worse in every round by more than max(20%, 3 ms): warn, or fail
//                             with enforce.time
//   drift (main)              worse than the median of the last 10 main runs by the same
//                             margin: warn
// Exit code 1 when anything fails.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Metric } from "./harness.ts";
import type { RunResults } from "./run.ts";

type Verdict = "ok" | "warn" | "fail";

interface Budget {
  max?: number;
  min?: number;
  absMax?: number;
}

interface Budgets {
  enforce: { network: boolean; time: boolean; kit: boolean };
  baseVsHead: { relative: number; absoluteMs: number };
  drift: { runs: number; relative: number; absoluteMs: number };
  metrics: Record<string, number | Budget>;
}

interface Row {
  key: string;
  kind: string;
  unit: string;
  value: number;
  base?: number;
  limit?: string;
  verdict: Verdict;
  note: string;
}

interface HistoryLine {
  commit: string;
  date: string;
  suite: string;
  metrics: Record<string, number>;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGETS = join(here, "budgets.json");

export function loadBudgets(file = DEFAULT_BUDGETS): Budgets {
  return JSON.parse(readFileSync(file, "utf8")) as Budgets;
}

function asBudget(b: number | Budget | undefined): Budget | undefined {
  return typeof b === "number" ? { max: b } : b;
}

function describe(b: Budget): string {
  return [b.max !== undefined ? `≤ ${b.max}` : "", b.min !== undefined ? `≥ ${b.min}` : "", b.absMax !== undefined ? `±${b.absMax}` : ""].filter(Boolean).join(", ");
}

function within(value: number, b: Budget): boolean {
  if (b.max !== undefined && value > b.max) return false;
  if (b.min !== undefined && value < b.min) return false;
  if (b.absMax !== undefined && Math.abs(value) > b.absMax) return false;
  return true;
}

// Rows for one set of results against the budgets (no base, no history).
export function judge(results: Record<string, Metric>, budgets: Budgets): Row[] {
  const rows: Row[] = [];
  for (const [key, m] of Object.entries(results)) {
    const row: Row = { key, kind: m.kind, unit: m.unit, value: m.median, verdict: "ok", note: "" };
    const budget = asBudget(budgets.metrics[key]);
    if (m.kind === "integrity") {
      if (m.median > 0) Object.assign(row, { verdict: "fail", note: "audio or protocol integrity" });
    } else if (["count", "approx", "legs", "sim", "level", "quality"].includes(m.kind)) {
      if (!budget) {
        Object.assign(row, { verdict: "warn", note: "no budget: add it with --update-budgets" });
      } else {
        row.limit = describe(budget);
        if (!within(m.median, budget)) {
          const enforced = m.kind === "count" || m.kind === "approx" ||
            ((m.kind === "legs" || m.kind === "sim") && budgets.enforce.network) ||
            ((m.kind === "level" || m.kind === "quality") && budgets.enforce.kit);
          Object.assign(row, { verdict: enforced ? "fail" : "warn", note: "outside its budget" });
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

// Is `head` worse than `base` by more than the margin (lower is better for everything timed)?
function worse(head: number, base: number, margin: { relative: number; absoluteMs: number }): boolean {
  return head > base * (1 + margin.relative) && head - base > margin.absoluteMs;
}

// Base vs head: time metrics, worse in every round.
function compareRounds(rows: Row[], heads: RunResults[], bases: RunResults[], budgets: Budgets): void {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const rounds = Math.min(heads.length, bases.length);
  for (const key of Object.keys(heads[0]?.metrics ?? {})) {
    const kind = heads[0].metrics[key].kind;
    if (kind !== "time") continue;
    const h: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const hv = heads[i].metrics[key]?.median;
      const bv = bases[i].metrics[key]?.median;
      if (hv === undefined || bv === undefined) continue;
      h.push(hv);
      b.push(bv);
    }
    if (!h.length) continue;
    const row = byKey.get(key)!;
    row.value = median(h);
    row.base = median(b);
    if (h.every((hv, i) => worse(hv, b[i], budgets.baseVsHead))) {
      row.verdict = budgets.enforce.time ? "fail" : "warn";
      row.note = `slower than base in all ${h.length} rounds`;
    }
  }
}

function drift(rows: Row[], history: HistoryLine[], budgets: Budgets): void {
  const recent = history.slice(-budgets.drift.runs);
  if (!recent.length) return;
  for (const row of rows) {
    if (!["time", "load", "sim", "level", "quality", "info"].includes(row.kind) || row.verdict !== "ok") continue;
    const past = recent.map((h) => h.metrics[row.key]).filter((v): v is number => typeof v === "number");
    if (past.length < 3) continue;
    const typical = median(past);
    row.base ??= typical;
    // Quality (SNR, pitch) is better when higher.
    const regressed = row.kind === "quality" ? worse(-row.value, -typical, { ...budgets.drift, absoluteMs: 0 }) && typical - row.value > 1 : worse(row.value, typical, budgets.drift);
    if (regressed) {
      row.verdict = "warn";
      row.note = `drifted from the median of the last ${past.length} main runs (${typical})`;
    }
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function readDir(dir: string | undefined): RunResults[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunResults);
}

// The kit's lines ({key, value, unit, kind}) as results.
export function readKitLines(file: string): RunResults {
  const metrics: Record<string, Metric> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const { key, value, unit, kind } = JSON.parse(line) as { key: string; value: number; unit: string; kind: Metric["kind"] };
    metrics[key] = { unit, kind, median: Math.round(value * 100) / 100, p95: Math.round(value * 100) / 100, n: 1 };
  }
  return {
    schema: 1, label: "kit", suite: "full", commit: process.env.GITHUB_SHA ?? "", relayCommit: "", branch: process.env.GITHUB_REF_NAME ?? "",
    date: new Date().toISOString(), runner: { os: process.platform, arch: process.arch, cpus: 0, cpuModel: "", node: process.version }, durationMs: 0, metrics, errors: [],
  };
}

function readHistory(file: string | undefined): HistoryLine[] {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as HistoryLine);
}

function format(v: number | undefined, unit: string): string {
  if (v === undefined) return "";
  return `${Math.round(v * 100) / 100} ${unit}`;
}

function summary(title: string, rows: Row[], extra: string[]): string {
  const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const line = (r: Row) => {
    const change = r.base !== undefined && r.base !== 0 ? `${r.value >= r.base ? "+" : ""}${Math.round(((r.value - r.base) / r.base) * 100)}%` : "";
    return `| ${icon[r.verdict]} | \`${r.key}\` | ${format(r.base, r.unit)} | ${format(r.value, r.unit)} | ${change} | ${r.limit ?? ""} | ${r.note} |`;
  };
  const header = "| | Metric | Base | Head | Change | Budget | Note |\n| --- | --- | --- | --- | --- | --- | --- |";
  const flagged = rows.filter((r) => r.verdict !== "ok");
  const parts = [`## ${title}`, "", `${count("fail")} failed, ${count("warn")} warnings, ${count("ok")} ok.`, ...extra, ""];
  if (flagged.length) parts.push(header, ...flagged.map(line), "");
  parts.push("<details><summary>All metrics</summary>", "", header, ...rows.map(line), "", "</details>", "");
  return parts.join("\n");
}

// For `run.ts --check`: this run alone against the budgets. True when nothing fails.
export function checkAgainstBudgets(results: RunResults): boolean {
  const rows = judge(results.metrics, loadBudgets());
  for (const r of rows.filter((r) => r.verdict !== "ok")) console.log(`${r.verdict === "fail" ? "FAIL" : "warn"}  ${r.key} = ${r.value} ${r.unit} (${r.limit ?? "no budget"}) ${r.note}`);
  const failed = rows.filter((r) => r.verdict === "fail").length;
  console.log(failed ? `\n${failed} failed` : "\nNo failures.");
  return failed === 0;
}

function updateBudgets(results: Record<string, Metric>, file: string): void {
  const budgets = loadBudgets(file);
  for (const [key, m] of Object.entries(results)) {
    if (m.kind === "count" || m.kind === "legs") budgets.metrics[key] = m.median;
    else if (m.kind === "approx") budgets.metrics[key] = Math.ceil(m.median * 1.25 + 1);
    else if (m.kind === "sim") budgets.metrics[key] = Math.ceil(m.median * 1.15);
  }
  budgets.metrics = Object.fromEntries(Object.entries(budgets.metrics).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(budgets, null, 2) + "\n");
  console.log(`Wrote ${file}`);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "head-dir": { type: "string" },
      "base-dir": { type: "string" },
      full: { type: "string" },
      "kit-lines": { type: "string" },
      budgets: { type: "string", default: DEFAULT_BUDGETS },
      history: { type: "string" },
      "append-history": { type: "string" },
      summary: { type: "string" },
      title: { type: "string", default: "Relay performance" },
      "update-budgets": { type: "boolean", default: false },
    },
  });
  const budgets = loadBudgets(values.budgets);
  const heads = readDir(values["head-dir"]);
  const bases = readDir(values["base-dir"]);
  const full = values.full && existsSync(values.full) ? (JSON.parse(readFileSync(values.full, "utf8")) as RunResults) : null;
  const kit = values["kit-lines"] && existsSync(values["kit-lines"]) ? readKitLines(values["kit-lines"]) : null;
  // Every metric this commit produced: the full run's, then the rounds' (quick metrics from the
  // rounds, where there are several samples), then the kit's.
  const merged: Record<string, Metric> = { ...full?.metrics, ...heads[0]?.metrics, ...kit?.metrics };
  // Integrity problems in any round count.
  for (const run of heads) for (const [k, m] of Object.entries(run.metrics)) if (m.kind === "integrity" && m.median > (merged[k]?.median ?? 0)) merged[k] = m;
  if (!Object.keys(merged).length) {
    console.error("No results to compare.");
    process.exit(1);
  }
  if (values["update-budgets"]) {
    updateBudgets(merged, values.budgets!);
    process.exit(0);
  }

  const rows = judge(merged, budgets);
  if (heads.length && bases.length) compareRounds(rows, heads, bases, budgets);
  const history = readHistory(values.history);
  drift(rows, history, budgets);

  const errors = [...(full?.errors ?? []), ...heads.flatMap((h) => h.errors)];
  const extra: string[] = [];
  const took = [full && `full suite ${(full.durationMs / 1000).toFixed(0)} s`, heads[0] && `quick suite ${(heads[0].durationMs / 1000).toFixed(0)} s × ${heads.length + bases.length} runs`].filter(Boolean);
  if (took.length) extra.push("", `Took: ${took.join(", ")}.`);
  if (bases.length) extra.push("", `Base \`${bases[0].relayCommit.slice(0, 7)}\` vs head \`${heads[0]?.relayCommit.slice(0, 7)}\`, ${Math.min(heads.length, bases.length)} rounds on the same runner.`);
  if (history.length) extra.push("", `Drift against the last ${Math.min(history.length, budgets.drift.runs)} main runs.`);
  if (errors.length) extra.push("", "Problems:", ...[...new Set(errors)].slice(0, 20).map((e) => `- ${e.split("\n")[0]}`));
  const text = summary(values.title!, rows, extra);
  if (values.summary) appendFileSync(values.summary, text);
  else console.log(text);

  if (values["append-history"]) {
    const line: HistoryLine = {
      commit: full?.commit ?? heads[0]?.commit ?? kit?.commit ?? "",
      date: new Date().toISOString(),
      suite: full ? "full" : kit ? "kit" : "quick",
      metrics: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    };
    const lines = [...history.map((h) => JSON.stringify(h)), JSON.stringify(line)];
    writeFileSync(values["append-history"], lines.join("\n") + "\n");
  }
  const failed = rows.filter((r) => r.verdict === "fail");
  for (const r of failed) console.error(`FAIL ${r.key} = ${r.value} ${r.unit} (${r.limit ?? ""}) ${r.note}`);
  process.exitCode = failed.length ? 1 : 0;
}
