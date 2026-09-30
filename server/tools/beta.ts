// The Beta's telemetry, per tester (the "Over&Out Beta telemetry spec" Claude Doc). Reads
// Cloud Logging and Firestore with your gcloud credentials; names come from Firestore here
// and never appear in the logs.
//
//   node tools/beta.ts summary [--days 7]
//       Per tester: rings sent and received and how they ended; latencies (p50 / p95) by device.
//
//   node tools/beta.ts tester <name or account ID> [--days 7]
//       That account's conversations, device events and problem reports.
//
//   node tools/beta.ts conversation <id>
//       One conversation: the relay's record, each device's summary, and whole timelines when
//       the account is in FULL_TIMELINE_USERS.
//
//   node tools/beta.ts run <conversation id> | run latest <name or account ID>
//       One test run in the steps the feasibility doc compares runs by: a first press
//       (press → go-ahead, → the relay), an answer (tap → audio session, the join and the
//       replay each way, arrival → handling, → first audio, whether the extension ran), the
//       network (interfaces, proxy, each request's timings) and main-queue stalls. Needs the
//       device's whole timeline (FULL_TIMELINE_USERS).
//
//   node tools/beta.ts pull <name or account ID>
//       Asks the account's iPhone and watch for their diagnostics logs (silently, during the
//       TestFlight Beta); they upload the next time the app refreshes.
//
//   node tools/beta.ts logs <name or account ID> [--conversation <id>] [--raw]
//       The newest uploaded log from each device, oldest line first.
//
//   node tools/beta.ts feedback [--all] | feedback resolve <id>
//       Problem reports sent from the app.
//
//   node tools/beta.ts usage [--days 7]
//       How Over&Out is used (the spec's usage analytics): the accounts now (pictures, friends,
//       devices, Ring Me On) and what people did in the last days (active accounts,
//       conversations, talk time, invites, onboarding). Totals only.
//
//   node tools/beta.ts stats [--days 30]
//       The daily rollup's documents (stats/{date}): DAU, WAU, MAU and the day's activity.
//
// --local <dir> reads a local relay's DATA_DIR (telemetry.jsonl and accounts.json) instead.
// GCP_PROJECT is the project (default walkie-talkie-relay).

import { parseArgs } from "node:util";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { Accounts } from "../src/accounts.ts";
import { MemoryDocs, type Docs } from "../src/docs.ts";
import { Firestore, gcloudAccessToken } from "../src/firestore.ts";
import { percentile, readEntries, type Entry } from "./telemetry-source.ts";
import { ACTIVITY_KINDS, activity, usageSnapshot } from "../src/stats.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string" },
    local: { type: "string" },
    conversation: { type: "string" },
    raw: { type: "boolean" },
    all: { type: "boolean" },
  },
});
const [command, arg, arg2] = positionals;
const local = values.local;
const since = new Date(Date.now() - Number(values.days ?? 7) * 86_400_000);
const docs: Docs = local
  ? new MemoryDocs(join(local, "accounts.json"))
  : new Firestore({ projectId: process.env.GCP_PROJECT ?? "walkie-talkie-relay", accessToken: gcloudAccessToken() });
const accounts = new Accounts(docs);

const names = new Map<string, string>();
async function nameOf(id: unknown): Promise<string> {
  if (typeof id !== "string") return "?";
  if (!names.has(id)) names.set(id, (await accounts.user(id).catch(() => undefined))?.name ?? `${id} (deleted)`);
  return names.get(id)!;
}

// An account ID, or the one account whose screen name matches (ignoring case).
async function resolveTester(who: string | undefined): Promise<string> {
  if (!who) fail("Name a tester (screen name or account ID).");
  if (who.startsWith("u_")) return who;
  const users = await docs.list("users");
  const found = users.filter((u) => String(u.data.name).toLowerCase() === who.toLowerCase());
  if (found.length === 1) return found[0].id;
  if (!found.length) fail(`No account named "${who}".`);
  fail(`Several accounts are named "${who}": ${found.map((u) => u.id).join(", ")}. Use the ID.`);
}

const time = (e: { timestamp: string }) => e.timestamp.slice(5, 16).replace("T", " ");
const ms = (v: number | undefined) => (v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`);

function latencyTable(summaries: Entry[]): string[] {
  const lines: string[] = [];
  const keys = ["ringDeliveryMs", "tapToFirstAudioMs", "pushToFirstAudioMs", "talkToGoAheadMs", "tapToJoinedMs", "receivedToJoinedMs"];
  for (const platform of ["watch", "iphone", "unknown"]) {
    const mine = summaries.filter((s) => s.platform === platform);
    for (const key of keys) {
      const values = mine.map((s) => s.intervals?.[key]).filter((v): v is number => typeof v === "number");
      if (!values.length) continue;
      lines.push(`    ${platform.padEnd(7)} ${key.replace(/Ms$/, "").padEnd(20)} p50 ${ms(percentile(values, 50)).padStart(8)}  p95 ${ms(percentile(values, 95)).padStart(8)}  n=${values.length}`);
    }
  }
  return lines;
}

function count<T>(items: T[], key: (t: T) => string): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
}

switch (command) {
  case "summary": {
    const entries = await readEntries({ kinds: ["oao.conversation", "oao.device", "oao.event", "oao.apns", "oao.api"], since, local });
    const conversations = entries.filter((e) => e.kind === "oao.conversation" && e.to);
    const summaries = entries.filter((e) => e.kind === "oao.device");
    console.log(`Since ${since.toISOString().slice(0, 10)}: ${conversations.length} conversations (${count(conversations, (c) => c.outcome)})`);
    const people = new Set<string>([...conversations.flatMap((c) => [c.from, c.to]), ...summaries.map((s) => s.userId)].filter(Boolean));
    for (const id of people) {
      const received = conversations.filter((c) => c.to === id);
      const sent = conversations.filter((c) => c.from === id);
      console.log(`\n  ${await nameOf(id)} (${id})`);
      console.log(`    rang others ${sent.length}: ${count(sent, (c) => c.outcome)}`);
      console.log(`    was rung ${received.length}: ${count(received, (c) => c.outcome)}; ring went to ${count(received.filter((c) => c.rings?.length), (c) => c.rings[0].platform)}`);
      const declined = summaries.filter((s) => s.userId === id && s.outcome === "declined").length;
      if (declined) console.log(`    declined ${declined}`);
      for (const line of latencyTable(summaries.filter((s) => s.userId === id))) console.log(line);
    }
    console.log("\n  Everyone:");
    for (const line of latencyTable(summaries)) console.log(line);
    const events = entries.filter((e) => e.kind === "oao.event");
    const apns = entries.filter((e) => e.kind === "oao.apns" && e.event !== "pushAccepted");
    const apiErrors = entries.filter((e) => e.kind === "oao.api" && e.status >= 500);
    console.log(`\n  Device events: ${count(events, (e) => e.name)}`);
    console.log(`  APNs failures: ${count(apns, (e) => `${e.pushType} ${e.status ?? ""} ${e.reason ?? ""}`.trim())}`);
    console.log(`  API 5xx: ${count(apiErrors, (e) => `${e.method} ${e.route}`)}`);
    break;
  }
  case "tester": {
    const id = await resolveTester(arg);
    const entries = await readEntries({
      kinds: ["oao.conversation", "oao.device", "oao.event", "oao.feedback", "oao.registration", "oao.api", "oao.diagnostics"],
      since,
      anyOf: [["from", id], ["to", id], ["userId", id]],
      local,
    });
    console.log(`${await nameOf(id)} (${id}), since ${since.toISOString().slice(0, 10)}\n`);
    const summaries = new Map<string, Entry[]>();
    for (const e of entries.filter((e) => e.kind === "oao.device")) summaries.set(e.conversationId, [...(summaries.get(e.conversationId) ?? []), e]);
    const conversations = entries.filter((e) => e.kind === "oao.conversation");
    if (!conversations.length) console.log("  No conversations.");
    for (const c of conversations) {
      const other = c.from === id ? `to ${await nameOf(c.to)}` : `from ${await nameOf(c.from)}`;
      const ring = c.rings?.length ? `, rang ${c.rings.map((r: any) => `${r.platform}${r.results.some((x: any) => !x.ok) ? " (APNs refused)" : ""}`).join(" then ")}` : "";
      const bad = ["push-failed", "unavailable", "unresolved"].includes(c.outcome) ? "  ←" : "";
      console.log(`  ${time(c)}  ${c.outcome.padEnd(11)} ${other}${ring}${c.moved ? ", moved" : ""}  ${c.conversationId}${bad}`);
      for (const s of summaries.get(c.conversationId) ?? []) {
        const intervals = Object.entries(s.intervals ?? {}).map(([k, v]) => `${k.replace(/Ms$/, "")} ${ms(v as number)}`).join(", ");
        const problems = Object.keys(s.problems ?? {}).length ? `  problems: ${Object.entries(s.problems).map(([k, v]) => `${k}×${v}`).join(", ")}` : "";
        console.log(`      ${s.userId === id ? "their" : "friend's"} ${s.platform}${s.build ? ` (build ${s.build})` : ""}: ${s.outcome}${s.via ? ` via ${s.via}` : ""}${intervals ? `; ${intervals}` : ""}${problems}`);
      }
    }
    const others = entries.filter((e) => !["oao.conversation", "oao.device"].includes(e.kind));
    if (others.length) console.log("\n  Events:");
    for (const e of others) {
      const { kind, timestamp, severity, userId, message, ...rest } = e;
      console.log(`  ${time(e)}  ${kind.replace("oao.", "").padEnd(12)} ${JSON.stringify(rest)}`);
    }
    break;
  }
  case "conversation": {
    if (!arg) fail("usage: conversation <id>");
    const entries = await readEntries({ kinds: ["oao.conversation", "oao.device", "oao.timeline", "oao.apns"], since: new Date(Date.now() - 30 * 86_400_000), anyOf: [["conversationId", arg]], local });
    if (!entries.length) fail(`Nothing logged for ${arg} in the last 30 days.`);
    const record = entries.find((e) => e.kind === "oao.conversation");
    const devices = entries.filter((e) => e.kind === "oao.timeline");
    const timeline = [
      ...(record?.events ?? []).map((e: any) => ({ ...e, who: "relay" })),
      ...devices.flatMap((d) => d.events.map((e: any) => ({ ...e, who: `${d.role}` }))),
    ].sort((a, b) => a.t - b.t);
    if (record) console.log(`${arg}: ${record.outcome}, ${await nameOf(record.from)} → ${await nameOf(record.to)}, intervals ${JSON.stringify(record.intervals)}\n`);
    const t0 = timeline[0]?.t ?? 0;
    for (const e of timeline) console.log(`  +${String(Math.round(e.t - t0)).padStart(6)} ms  ${e.who.padEnd(9)} ${e.name}${e.detail ? `  — ${e.detail}` : ""}`);
    for (const s of entries.filter((e) => e.kind === "oao.device")) {
      console.log(`\n  ${await nameOf(s.userId)}'s ${s.platform} (${s.role}${s.build ? `, build ${s.build}` : ""}): ${s.outcome}${s.via ? ` via ${s.via}` : ""}${s.route ? `, ${s.route}` : ""}`);
      for (const [k, v] of Object.entries(s.intervals ?? {})) console.log(`    ${ms(v as number).padStart(9)}  ${k.replace(/Ms$/, "")}`);
      if (Object.keys(s.problems ?? {}).length) console.log(`    problems: ${JSON.stringify(s.problems)}`);
    }
    break;
  }
  case "run": {
    let conversationId = arg;
    if (arg === "latest") {
      const id = await resolveTester(arg2);
      const recent = await readEntries({ kinds: ["oao.conversation"], since, anyOf: [["from", id], ["to", id]], local });
      conversationId = recent.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)?.conversationId;
      if (!conversationId) fail(`No conversations for ${arg2} since ${since.toISOString().slice(0, 10)}.`);
    }
    if (!conversationId) fail("usage: run <conversation id> | run latest <name>");
    const entries = await readEntries({ kinds: ["oao.conversation", "oao.device", "oao.timeline"], since: new Date(Date.now() - 30 * 86_400_000), anyOf: [["conversationId", conversationId]], local });
    const record = entries.find((e) => e.kind === "oao.conversation");
    type Ev = { t: number; name: string; detail?: string };
    const relay: Ev[] = (record?.events ?? []).slice().sort((a: Ev, b: Ev) => a.t - b.t);
    const find = (events: Ev[], name: string, after = -Infinity) => events.find((e) => e.name === name && e.t >= after);
    const span = (from?: Ev, to?: Ev) => (from && to ? ms(Math.round(to.t - from.t)) : "—");
    const row = (label: string, value: string, note = "") => console.log(`    ${label.padEnd(34)} ${value.padStart(9)}${note ? `  ${note}` : ""}`);
    console.log(record
      ? `${conversationId}: ${record.outcome}, ${await nameOf(record.from)} → ${await nameOf(record.to)}, ${time(record)}`
      : `${conversationId}: no relay record (yet)`);
    const timelines = entries.filter((e) => e.kind === "oao.timeline");
    if (!timelines.length) console.log("\n  No device timeline: the device's account isn't in FULL_TIMELINE_USERS, or it hasn't uploaded.");
    for (const d of timelines) {
      const events: Ev[] = d.events.slice().sort((a: Ev, b: Ev) => a.t - b.t);
      const summary = entries.find((e) => e.kind === "oao.device" && e.deviceId === d.deviceId);
      // A bot's timeline (no platform) says only what the relay did with its talk.
      if (!summary?.platform || summary.platform === "unknown") {
        const press = find(events, "talkPressed");
        console.log(`\n  ${await nameOf(d.userId)} (a bot, ${d.role}): press → talk-start at the relay ${span(press, find(relay, "talkStart", press?.t))}, → floor granted ${span(press, find(events, "floorGranted", press?.t))}`);
        continue;
      }
      console.log(`\n  ${await nameOf(d.userId)}'s ${summary.platform}${summary.build ? `, build ${summary.build}` : ""} (${d.role})`);
      const network = find(events, "network");
      if (network) row("network", "", network.detail);
      if (d.role === "sender") {
        const press = find(events, "talkPressed");
        const preconnected = find(events, "preconnected");
        row("stream open before the press", preconnected && press && preconnected.t <= press.t ? span(preconnected, press) : "no", preconnected ? "" : "a cold connection");
        row("press → audio session", span(press, find(events, "audioActivated", press?.t)));
        row("press → go-ahead (mic, haptic)", span(press, find(events, "captureStarted", press?.t)));
        row("press → stream open", span(press, find(events, "helloAckArrived", press?.t) ?? find(events, "socketOpen", press?.t)));
        row("press → talk-start at the relay", span(press, find(relay, "talkStart", press?.t)));
        row("press → floor granted", span(press, find(events, "floorGranted", press?.t)));
      } else {
        const tap = find(events, "answerTapped");
        const nse = find(events, "nseReceived");
        const fetched = find(events, "nseFetchEnded");
        row("answered", "", tap?.detail ?? "not answered");
        row("extension downloaded the message", nse ? "yes" : "no", fetched?.detail ?? (nse ? "" : "watchOS didn't run it, or the app was frontmost"));
        const preconnected = find(events, "preconnected");
        if (preconnected) row("stream open before the tap", preconnected.t <= (tap?.t ?? Infinity) ? span(preconnected, tap) : "no");
        const joinSent = find(events, "joinSent", tap?.t);
        const helloAck = find(events, "helloAckArrived", tap?.t);
        const joined = find(relay, "receiverJoined", tap?.t);
        const replay = find(relay, "replayStarted", tap?.t) ?? joined;
        const arrived = find(events, "joinedArrived", tap?.t) ?? find(events, "firstFrameArrived", tap?.t);
        const handled = find(events, "joined", tap?.t);
        row("tap → audio session", span(tap, find(events, "audioActivated", tap?.t)), (() => {
          const returned = find(events, "audioActivationReturned", tap?.t);
          const activated = find(events, "audioActivated", tap?.t);
          return returned && activated ? `(returned ${span(tap, returned)}, then ${span(returned, activated)} on the main queue)` : "";
        })());
        if (helloAck) row("tap → stream open", span(tap, helloAck), "(a new stream)");
        row("join sent", joinSent ? span(tap, joinSent) : "—", joinSent?.detail ?? "");
        row("join sent → relay joined", span(joinSent, joined));
        row("relay replay → arrived at the device", span(replay, arrived));
        row("arrived → handled (main queue)", span(arrived, handled));
        row("tap → first audio", span(tap, find(events, "burstAudioStarted", tap?.t)));
      }
      const stalls = events.filter((e) => e.name === "mainStall");
      row("main-queue stalls ≥ 200 ms", String(stalls.length), stalls.length ? `longest ${Math.max(...stalls.map((s) => parseInt(s.detail ?? "0")))} ms` : "");
      for (const e of events.filter((e) => e.name.startsWith("net-"))) row(e.name, "", e.detail);
      for (const e of events.filter((e) => /^post\d$/.test(e.name))) row(e.name, "", e.detail);
      if (summary && Object.keys(summary.problems ?? {}).length) row("problems", "", JSON.stringify(summary.problems));
    }
    break;
  }
  case "pull": {
    const id = await resolveTester(arg);
    await accounts.requestDiagnostics(id);
    console.log(`Asked ${await nameOf(id)}'s devices for their logs. They upload the next time Over&Out refreshes (opening it, or the watch's idle reload); then run: node tools/beta.ts logs ${id}`);
    break;
  }
  case "logs": {
    const id = await resolveTester(arg);
    const uploads = (await docs.query("diagnostics", { where: { field: "userId", op: "EQUAL", value: id } }))
      .sort((a, b) => Number(b.data.createdAt instanceof Date ? b.data.createdAt.getTime() : 0) - Number(a.data.createdAt instanceof Date ? a.data.createdAt.getTime() : 0));
    const newest = new Map<string, (typeof uploads)[number]>();
    for (const u of uploads) if (!newest.has(String(u.data.deviceId))) newest.set(String(u.data.deviceId), u);
    if (!newest.size) console.log(`No logs from ${await nameOf(id)} yet. Ask with: node tools/beta.ts pull ${id}`);
    for (const u of newest.values()) {
      const created = u.data.createdAt instanceof Date ? u.data.createdAt.toISOString() : "?";
      console.log(`\n=== ${u.data.platform ?? "device"} ${u.data.deviceId}, build ${u.data.build ?? "?"}, uploaded ${created} (${u.data.size} bytes compressed)`);
      const bytes = Buffer.from(u.data.log as Uint8Array);
      const text = (u.data.encoding === "deflate-raw" ? inflateRawSync(bytes) : gunzipSync(bytes)).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        if (values.conversation && !line.includes(values.conversation)) continue;
        if (values.raw) {
          console.log(line);
          continue;
        }
        try {
          const e = JSON.parse(line) as { t?: number; name?: string; conversationId?: string; [k: string]: unknown };
          const { t, name, ...rest } = e;
          console.log(`  ${t ? new Date(t).toISOString().slice(5, 23).replace("T", " ") : "?".padEnd(18)}  ${String(name).padEnd(22)} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`);
        } catch {
          console.log(`  ${line}`);
        }
      }
    }
    break;
  }
  case "feedback": {
    if (arg === "resolve") {
      if (!arg2) fail("usage: feedback resolve <id>");
      await docs.commit([{ set: `feedback/${arg2}`, data: { status: "resolved" }, fields: ["status"], exists: true }]);
      console.log(`Resolved ${arg2}.`);
      break;
    }
    const rows = values.all
      ? await docs.list("feedback")
      : await docs.query("feedback", { where: { field: "status", op: "EQUAL", value: "open" } });
    const when = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 16).replace("T", " ") : "?");
    rows.sort((a, b) => when(b.data.createdAt).localeCompare(when(a.data.createdAt)));
    if (!rows.length) console.log(values.all ? "No problem reports." : "No open problem reports.");
    for (const r of rows) {
      console.log(`${r.id}  ${when(r.data.createdAt)}  ${r.data.status}  ${await nameOf(r.data.userId)} (${r.data.userId}), ${r.data.platform ?? "?"} build ${r.data.build ?? "?"}${r.data.diagnostics ? ", logs requested" : ""}`);
      console.log(`    "${r.data.note}"`);
    }
    break;
  }
  case "usage": {
    const [usage, entries] = await Promise.all([usageSnapshot(docs), readEntries({ kinds: ACTIVITY_KINDS, since, local })]);
    const line = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
    console.log(`Accounts now: ${usage.accounts} (${usage.newAccounts7d} new in 7 days), ${usage.friendships} friendships`);
    console.log(`  pictures: ${line(usage.pictures)}`);
    console.log(`  friends per account: ${["0", "1", "2-3", "4-9", "10+"].map((k) => `${k}: ${usage.friends[k] ?? 0}`).join(", ")}${usage.hoursToFirstFriendP50 !== undefined ? `; first friend after ${usage.hoursToFirstFriendP50} h (median)` : ""}`);
    console.log(`  with favorites: ${usage.accountsWithFavorites}`);
    console.log(`  devices: ${line(usage.devices)}; iPhones with walkie-talkie on ${usage.iphones.walkieTalkie}, app-only ${usage.iphones.appOnly}`);
    console.log(`  Ring Me On: ${line(usage.ringOn)}`);
    console.log(`  last heard from someone: ${line(usage.lastHeard)}`);
    const a = activity(entries);
    const conversations = Object.values(a.conversations).reduce((n, c) => n + c, 0);
    console.log(`\nSince ${since.toISOString().slice(0, 10)}: ${a.activeAccounts} active accounts, ${a.talkers} rang someone, ${a.openedApp} opened the app`);
    console.log(`  conversations ${conversations}: ${line(a.conversations)}; ${a.conversationsWithReplies} with a reply; ${a.talkMinutes} minutes of talk`);
    console.log(`  rings went to: ${line(a.ringsTo)}; answered via: ${line(a.answeredVia)}; talked from: ${line(a.talkedFrom)}; declined ${a.declined}`);
    console.log(`  sign-ups ${a.newAccounts}, deletions ${a.deletedAccounts}; invites created ${a.invitesCreated}, accepted ${a.invitesAccepted}${a.inviteAcceptHoursP50 !== undefined ? ` (after ${a.inviteAcceptHoursP50} h, median)` : ""}`);
    console.log(`  picture changes: ${line(a.pictureChanges)}; favorites added ${a.favoritesAdded}; onboarding finished ${a.onboardingFinished} (walkie-talkie on ${a.onboardingWalkieTalkieOn})`);
    break;
  }
  case "stats": {
    const days = (await docs.list("stats")).map((d) => d.data as any).filter((d) => Date.parse(`${d.date}T00:00:00Z`) >= Date.now() - Number(values.days ?? 30) * 86_400_000);
    days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!days.length) console.log("No daily stats yet (the rollup runs at 00:30 UTC; deploy/gcp/setup-stats.sh sets it up).");
    else console.log("date         DAU  WAU  MAU  talkers  convs  replies  talk min  sign-ups  invites  accounts");
    for (const d of days) {
      const convs = Object.values(d.day.conversations ?? {}).reduce((n: number, c) => n + Number(c), 0);
      console.log(`${d.date}  ${String(d.dau).padStart(4)} ${String(d.wau).padStart(4)} ${String(d.mau).padStart(4)}  ${String(d.day.talkers).padStart(7)}  ${String(convs).padStart(5)}  ${String(d.day.conversationsWithReplies).padStart(7)}  ${String(d.day.talkMinutes).padStart(8)}  ${String(d.day.newAccounts).padStart(8)}  ${String(`${d.day.invitesAccepted}/${d.day.invitesCreated}`).padStart(7)}  ${String(d.usage.accounts).padStart(8)}`);
    }
    break;
  }
  default:
    fail("usage: node tools/beta.ts summary | tester <who> | conversation <id> | pull <who> | logs <who> | feedback [--all] | feedback resolve <id> | usage | stats  [--days N] [--local <dir>]");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
