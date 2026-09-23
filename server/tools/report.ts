// Prints conversation timelines and the spike's key intervals.
//
//   node tools/report.ts              latest conversation
//   node tools/report.ts <id>         a specific conversation
//   node tools/report.ts --all        every conversation, plus medians
//
// Server and token come from SPIKE_SERVER (default http://localhost:8080) and SPIKE_TOKEN.

import { formatTimeline } from "../src/report.ts";
import type { RingAttempt } from "../src/report.ts";
import type { TimelineEntry } from "../src/store.ts";

const server = process.env.SPIKE_SERVER ?? "http://localhost:8080";
const token = process.env.SPIKE_TOKEN;

async function get(path: string): Promise<any> {
  const res = await fetch(new URL(path, server), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json();
}

const arg = process.argv[2];
const list = ((await get("/v1/metrics")) as Array<{ conversationId: string; startedAt: number | null }>).sort(
  (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
);
if (list.length === 0) {
  console.log("No conversations recorded yet.");
  process.exit(0);
}

const ids = arg === "--all" ? list.map((c) => c.conversationId) : [arg ?? list[list.length - 1].conversationId];
const byLabel = new Map<string, number[]>();
for (const id of ids) {
  const { timeline, attempts } = (await get(`/v1/metrics/${id}`)) as { timeline: TimelineEntry[]; attempts: RingAttempt[] };
  console.log(formatTimeline(id, timeline));
  for (const attempt of attempts) {
    for (const i of attempt.intervals) byLabel.set(i.label, [...(byLabel.get(i.label) ?? []), i.ms]);
  }
}

if (ids.length > 1) {
  console.log(`Medians across ${ids.length} conversations (each ring counted separately):`);
  for (const [label, values] of byLabel) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`  ${String(median).padStart(6)} ms  ${label}  (n=${values.length})`);
  }
}
