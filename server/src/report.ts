// Turns a conversation timeline into the intervals the spike cares about.
// All times are on the server clock; device events were shifted by their clock offset,
// so cross-device intervals carry roughly the round-trip error of that estimate.

import type { TimelineEntry } from "./store.ts";

export interface Interval {
  label: string;
  from: string;
  to: string;
  ms: number;
}

// One ring and what followed it, up to the next ring. A conversation can contain several
// (an unanswered ring, then another Talk that rings again).
export interface RingAttempt {
  startedAt: number;
  intervals: Interval[];
}

// [label, from event, to event]. Event names are prefixed with their source.
const INTERVALS: Array<[string, string, string]> = [
  ["Sender: press → floor granted", "sender.talkPressed", "sender.floorGranted"],
  ["Sender: press → first frame sent", "sender.talkPressed", "sender.firstFrameSent"],
  ["Server: talk start → push sent", "server.talkStart", "server.pushSent"],
  ["APNs: push sent → accepted", "server.pushSent", "server.pushAccepted"],
  ["Push sent → watch woke (cross-device)", "server.pushSent", "receiver.pushReceived"],
  ["Watch: push → call reported", "receiver.pushReceived", "receiver.callReported"],
  ["Human: ring → answer tap", "receiver.callReported", "receiver.answerTapped"],
  ["Watch: answer → socket open", "receiver.answerTapped", "receiver.socketOpen"],
  ["Watch: answer → audio session active", "receiver.answerTapped", "receiver.audioActivated"],
  ["Watch: answer → first audio", "receiver.answerTapped", "receiver.firstAudioScheduled"],
  ["Total: press → first audio (cross-device)", "sender.talkPressed", "receiver.firstAudioScheduled"],
  ["Total: push sent → first audio, minus human answer time", "server.pushSent", "receiver.firstAudioScheduled"],
];

// Sender events that belong to a ring happen just before the server sends the push.
const LEAD_MS = 5_000;

export function summarize(timeline: TimelineEntry[]): Interval[] {
  const first = new Map<string, number>();
  for (const e of timeline) {
    const key = `${e.source}.${e.name}`;
    if (!first.has(key)) first.set(key, e.t);
  }
  const human = (first.get("receiver.answerTapped") ?? NaN) - (first.get("receiver.callReported") ?? NaN);
  const out: Interval[] = [];
  for (const [label, from, to] of INTERVALS) {
    const a = first.get(from);
    const b = first.get(to);
    if (a === undefined || b === undefined || b < a) continue;
    let ms = b - a;
    if (label.includes("minus human") && Number.isFinite(human)) ms -= human;
    out.push({ label, from, to, ms: Math.round(ms) });
  }
  return out;
}

// Splits the timeline at each push and summarizes each ring separately.
export function summarizeAttempts(timeline: TimelineEntry[]): RingAttempt[] {
  const pushes = timeline.filter((e) => e.source === "server" && e.name === "pushSent").map((e) => e.t);
  if (pushes.length <= 1) return [{ startedAt: timeline[0]?.t ?? 0, intervals: summarize(timeline) }];
  return pushes.map((pushAt, i) => {
    const start = Math.max(pushAt - LEAD_MS, i > 0 ? pushes[i - 1] : -Infinity);
    const end = i + 1 < pushes.length ? pushes[i + 1] - LEAD_MS : Infinity;
    const segment = timeline.filter((e) => e.t >= start && e.t < Math.max(end, pushAt + 1));
    return { startedAt: pushAt, intervals: summarize(segment) };
  });
}

export function formatTimeline(conversationId: string, timeline: TimelineEntry[]): string {
  if (timeline.length === 0) return `Conversation ${conversationId}: no events\n`;
  const t0 = timeline[0].t;
  const lines = [`Conversation ${conversationId}`, ""];
  for (const e of timeline) {
    const who = e.source === "server" ? "server" : `${e.source}${e.userId ? ` (${e.userId})` : ""}`;
    lines.push(`  +${String(Math.round(e.t - t0)).padStart(6)} ms  ${who.padEnd(22)} ${e.name}${e.detail ? `  — ${e.detail}` : ""}`);
  }
  const attempts = summarizeAttempts(timeline);
  attempts.forEach((attempt, i) => {
    if (!attempt.intervals.length) return;
    const title = attempts.length > 1 ? `Ring ${i + 1} (at +${Math.round(attempt.startedAt - t0)} ms)` : "Intervals";
    lines.push("", `  ${title}:`);
    for (const interval of attempt.intervals) lines.push(`    ${String(interval.ms).padStart(6)} ms  ${interval.label}`);
  });
  return lines.join("\n") + "\n";
}
