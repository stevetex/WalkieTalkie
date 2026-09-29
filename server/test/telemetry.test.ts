// Beta telemetry (telemetry.ts): the relay's conversation records, the devices' summaries, the
// sinks, device events, and the API's diagnostics, feedback and error entries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  CloudLoggingSink,
  MemorySink,
  TelemetryMetricsStore,
  cleanEvents,
  conversationRecord,
  deviceSummary,
  parsePushDetail,
} from "../src/telemetry.ts";
import type { TimelineEntry } from "../src/store.ts";
import { startServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { createApi } from "../src/api.ts";
import { MemoryDocs } from "../src/docs.ts";
import { SessionSigner, SessionVerifier, generateSigningKey } from "../src/session.ts";
import { SpikeClient } from "../tools/client.ts";

const server = (name: string, t: number, detail?: string): TimelineEntry => ({ source: "server", name, t, ...(detail ? { detail } : {}) });

test("a conversation's outcome, rings and intervals come from the relay's events", () => {
  const answered = conversationRecord("c1", [
    server("talkStart", 1000, "u_bob -> u_alice"),
    server("pushSent", 1070, "watch"),
    server("pushAccepted", 1120, "alert: status 200 in 50 ms"),
    server("floorGrantSent", 1125, "u_bob"),
    server("burstEnded", 3600, "u_bob 2600 ms, 130 frames"),
    server("receiverJoined", 9000, "3 buffered"),
    server("talkStart", 11000, "u_alice -> u_bob"),
    server("burstEnded", 12500, "u_alice 1500 ms, 75 frames"),
    server("talkStart", 13000, "u_bob -> u_alice"),
    server("burstEnded", 14000, "u_bob 1000 ms, 50 frames"),
  ]);
  assert.equal(answered.outcome, "answered");
  assert.equal(answered.from, "u_bob");
  assert.equal(answered.to, "u_alice");
  assert.equal(answered.delivered, true);
  assert.equal(answered.ringPlatform, "watch");
  assert.deepEqual(answered.rings, [{ at: 1070, platform: "watch", devices: 1, results: [{ ok: true, kind: "alert", status: 200, ms: 50 }] }]);
  assert.deepEqual(answered.intervals, { talkToPushMs: 70, apnsAcceptMs: 50, pushToJoinMs: 7930 });
  assert.deepEqual(
    [answered.bursts, answered.callerBursts, answered.callerTalkMs, answered.calleeBursts, answered.calleeTalkMs],
    [3, 2, 3600, 1, 1500],
  );

  const outcome = (...names: Array<[string, string?]>) =>
    conversationRecord("c", [server("talkStart", 0, "a -> b"), ...names.map(([n, d], i) => server(n, i + 1, d))]).outcome;
  assert.equal(outcome(["pushSent", "watch"], ["pushAccepted", "alert: status 200 in 5 ms"], ["ringTimedOut"]), "missed");
  assert.equal(outcome(["ringRefused", "not friends"]), "refused");
  assert.equal(outcome(["pushSkipped", "no device for b"]), "unavailable");
  assert.equal(outcome(["pushSent", "iphone"], ["pushFailed", "pushtotalk: status 410 Unregistered in 40 ms"]), "push-failed");
  assert.equal(outcome(["firstFrameForwardedLive"]), "live");
  assert.equal(outcome(["pushSent", "watch"], ["pushAccepted", "alert: status 200 in 5 ms"], ["movedDevice", "a"], ["receiverJoined"]), "answered");
});

test("push details parse into status, reason and retries", () => {
  assert.deepEqual(parsePushDetail("pushtotalk: status 200 retried after ECONNRESET in 80 ms"), { kind: "pushtotalk", status: 200, reason: "retried after ECONNRESET", ms: 80, retried: true });
  assert.deepEqual(parsePushDetail("alert: status 400 BadDeviceToken in 31 ms (dry run)"), { kind: "alert", status: 400, reason: "BadDeviceToken", ms: 31 });
  assert.deepEqual(parsePushDetail("in-app ring"), { kind: "in-app ring" });
  assert.deepEqual(parsePushDetail("device lookup: timeout"), { kind: "device lookup" });
});

test("a watch's summary: ring delivery, tap → first audio and the time to answer", () => {
  // Device clock 500 ms behind the relay's.
  const summary = deviceSummary({
    conversationId: "c1",
    userId: "u_alice",
    role: "receiver",
    clockOffsetMs: 500,
    events: [
      { name: "notificationDelivered", t: 1000 },
      { name: "notificationOpened", t: 17_000 },
      { name: "pushSentAtServer", t: 17_010, detail: "1300" },
      { name: "answerTapped", t: 17_000, detail: "notification" },
      { name: "audioActivated", t: 17_190 },
      { name: "joined", t: 17_400, detail: "0 buffered bursts" },
      { name: "firstAudioScheduled", t: 17_670 },
      { name: "log", t: 17_700, detail: "Answering Bob" },
    ],
  }, []);
  assert.equal(summary.platform, "watch");
  assert.equal(summary.outcome, "answered");
  assert.equal(summary.via, "notification");
  assert.deepEqual(summary.intervals, { ringDeliveryMs: 200, tapToFirstAudioMs: 670, tapToJoinedMs: 400, tapToAudioMs: 190, humanAnswerMs: 16_000 });
  assert.deepEqual(summary.problems, {});
  // Free text never reaches a summary.
  assert.doesNotMatch(JSON.stringify(summary), /Bob/);
});

test("an iPhone's summary: push → first audio through PushToTalk, and the audio route without names", () => {
  const summary = deviceSummary({
    conversationId: "c2",
    userId: "u_steve",
    role: "receiver",
    clockOffsetMs: 0,
    device: { platform: "iphone", model: "iPhone18,2", os: "27.0", build: "76" },
    events: [
      { name: "pushSentAtServer", t: 1310, detail: "1000" },
      { name: "pttPushReceived", t: 1280 },
      { name: "answerTapped", t: 1280, detail: "pushtotalk" },
      { name: "audioActivated", t: 1450, detail: "BluetoothHFP, in BluetoothHFP, PlayAndRecord Default" },
      { name: "joined", t: 1890 },
      { name: "firstAudioScheduled", t: 1900 },
      { name: "pttLeft", t: 5000, detail: "reason 1" },
    ],
  }, []);
  assert.deepEqual(
    { platform: summary.platform, build: summary.build, route: summary.route, outcome: summary.outcome },
    { platform: "iphone", build: "76", route: "BluetoothHFP", outcome: "answered" },
  );
  assert.deepEqual(summary.intervals, { ringDeliveryMs: 280, pushToFirstAudioMs: 900, receivedToJoinedMs: 610, receivedToAudioMs: 170 });
  assert.deepEqual(summary.problems, { pttLeft: 1 });
});

test("a sender's summary, a declined ring, and the relay's push time when the device has none", () => {
  const sender = deviceSummary({ conversationId: "c", userId: "u_b", role: "sender", clockOffsetMs: 0, events: [{ name: "talkPressed", t: 100 }, { name: "floorGranted", t: 380 }, { name: "firstFrameSent", t: 130 }] }, []);
  assert.deepEqual([sender.outcome, sender.intervals], ["sent", { talkToGoAheadMs: 280, talkToFirstFrameMs: 30 }]);
  const declined = deviceSummary({ conversationId: "c", userId: "u_a", role: "receiver", clockOffsetMs: 0, events: [{ name: "notificationDelivered", t: 50 }, { name: "ringDeclined", t: 900 }] }, [server("pushSent", 20)]);
  assert.deepEqual([declined.outcome, declined.intervals], ["declined", { ringDeliveryMs: 30 }]);
});

test("the store writes one record per conversation once it goes quiet, and summarizes later uploads", async () => {
  const sink = new MemorySink();
  const store = new TelemetryMetricsStore(sink, { endedMs: 5, quietMs: 60_000, node: "relay-test", fullTimelineUsers: ["u_steve"] });
  store.server("c1", "talkStart", 1000, "u_bob -> u_steve");
  store.server("c1", "pushSent", 1060, "iphone");
  store.server("c1", "pushFailed", 1090, "pushtotalk: status 500 InternalServerError in 30 ms");
  store.server("c1", "pushAccepted", 1100, "pushtotalk: status 200 retried after ECONNRESET in 40 ms");
  store.server("c1", "pushAccepted", 1100, "in-app ring");
  store.server("c1", "receiverJoined", 2000);
  assert.deepEqual(sink.of("oao.apns").map((e) => [e.event, e.status, e.severity]), [["pushFailed", 500, "WARNING"], ["pushAccepted", 200, "INFO"]]);
  // Nothing until the relay forgets the conversation, however quiet it goes meanwhile.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sink.of("oao.conversation").length, 0);
  store.server("c1", "conversationEnded", 3000);
  await new Promise((r) => setTimeout(r, 30));
  const [record] = sink.of("oao.conversation");
  assert.equal(record.outcome, "answered");
  assert.equal(record.node, "relay-test");

  // The iPhone uploads after the record went out: the relay still has its events.
  await store.upload({ conversationId: "c1", userId: "u_steve", role: "receiver", clockOffsetMs: 0, events: [{ name: "pttPushReceived", t: 1300 }, { name: "log", t: 1301, detail: "from Bob" }] });
  assert.equal(sink.of("oao.device")[0].intervals && (sink.of("oao.device")[0].intervals as Record<string, number>).ringDeliveryMs, 240);
  // Steve's account is marked for full detail: the whole timeline too, less its free text.
  const [timeline] = sink.of("oao.timeline");
  assert.deepEqual((timeline.events as Array<{ name: string }>).map((e) => e.name), ["pttPushReceived"]);
  await store.upload({ conversationId: "c1", userId: "u_other", role: "sender", clockOffsetMs: 0, events: [] });
  assert.equal(sink.of("oao.timeline").length, 1);
  // For report.ts and the bot, for a while: the relay's events and the devices' together.
  assert.deepEqual((await store.timeline("c1")).map((e) => `${e.source}.${e.name}`), [
    "server.talkStart", "server.pushSent", "server.pushFailed", "server.pushAccepted", "server.pushAccepted", "receiver.pttPushReceived", "receiver.log", "server.receiverJoined", "server.conversationEnded",
  ]);
});

test("Cloud Logging entries go out in batches, with one retry on a server error", async () => {
  const bodies: any[] = [];
  let failures = 1;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (failures-- > 0) return new Response("busy", { status: 503 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const sink = new CloudLoggingSink({ projectId: "p", accessToken: async () => "t", labels: { node: "relay-1" }, batchMs: 10, maxBatch: 3, fetchFn });
  sink.write({ kind: "oao.event", name: "a" });
  sink.write({ kind: "oao.event", name: "b" }, "WARNING");
  await new Promise((r) => setTimeout(r, 40));
  await sink.flush();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].logName, "projects/p/logs/oao-telemetry");
  assert.deepEqual(bodies[1].labels, { node: "relay-1" });
  assert.deepEqual(bodies[1].entries.map((e: any) => [e.jsonPayload.name, e.severity]), [["a", "INFO"], ["b", "WARNING"]]);
  for (const name of ["c", "d", "e"]) sink.write({ kind: "oao.event", name });
  await sink.flush();
  assert.equal(bodies.at(-1).entries.length, 3);
});

test("device events keep only named, short, simple values", () => {
  const events = cleanEvents({
    device: { platform: "iphone", build: "77", nested: { no: 1 } },
    events: [
      { name: "pttLeft", t: 1_790_000_000_000, fields: { reason: 1, byApp: false, kind: "overwrite", note: "x".repeat(500) } },
      { name: "bad name!", t: 1 },
      { name: "crash", fields: { signal: "SIGABRT", frames: ["a"] } },
    ],
  }, { userId: "u_a", deviceId: "d1" });
  assert.equal(events.length, 2);
  assert.deepEqual({ ...events[0], note: undefined }, { kind: "oao.event", name: "pttLeft", userId: "u_a", deviceId: "d1", at: new Date(1_790_000_000_000).toISOString(), platform: "iphone", build: "77", reason: 1, byApp: false, note: undefined });
  assert.equal((events[0].note as string).length, 200);
  assert.deepEqual(events[1], { kind: "oao.event", name: "crash", userId: "u_a", deviceId: "d1", platform: "iphone", build: "77", signal: "SIGABRT" });
  assert.deepEqual(cleanEvents({ events: "no" }, { userId: "u", deviceId: "d" }), []);
});

test("through the relay and API: a record and summary per conversation, events, feedback, pulls and deletion", async () => {
  const now = { t: Date.now() };
  const { signingKey, publicKeys } = generateSigningKey("test");
  const signer = new SessionSigner(signingKey, () => now.t);
  const verifier = new SessionVerifier(publicKeys, () => now.t);
  const docs = new MemoryDocs();
  const accounts = new Accounts(docs);
  const sink = new MemorySink();
  const lines: string[] = [];
  const api = createApi({
    accounts,
    signer,
    verifier,
    apple: { verify: async (identityToken) => ({ sub: identityToken }) },
    revoker: null,
    inviteBaseUrl: "https://overandout.app/i/",
    log: (line) => lines.push(line),
    telemetry: sink,
  });
  const running = await startServer({
    port: 0,
    dataDir: null,
    token: "shared",
    sessions: verifier,
    accounts,
    api,
    pusher: new DryRunPusher(),
    metrics: new TelemetryMetricsStore(sink, { endedMs: 10 }),
    telemetry: sink,
  });
  const url = `http://localhost:${running.port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(new URL(path, url), {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const signIn = async (sub: string, name: string, deviceId: string) =>
    (await call("POST", "/v1/auth/apple", null, { identityToken: sub, nonce: "n", name, deviceId, platform: "iphone" })).body;
  try {
    const alice = await signIn("apple.alice", "Alice", "alice-phone");
    const watch = (await call("POST", "/v1/auth/device", alice.token, { deviceId: "alice-watch", platform: "watch" })).body.token;
    assert.equal((await call("PUT", "/v1/me/device", watch, { platform: "watch", pushToken: "poll:alice" })).status, 200);
    const [registration] = sink.of("oao.registration");
    assert.deepEqual([registration.userId, registration.deviceId, registration.platform], [alice.user.id, "alice-watch", "watch"]);
    assert.doesNotMatch(JSON.stringify(registration), /poll:alice/);
    const bob = await signIn("apple.bob", "Bob", "bob-phone");
    const invite = await call("POST", "/v1/invites", alice.token);
    await call("POST", `/v1/invites/${invite.body.code}/accept`, bob.token);

    // Bob rings Alice's watch, which answers.
    const bobClient = new SpikeClient({ server: url, userId: "ignored", token: bob.token });
    await bobClient.connect();
    const { conversationId } = await bobClient.talk(alice.user.id, Buffer.alloc(640 * 3, 1), { realtime: false });
    const aliceWatch = new SpikeClient({ server: url, userId: "ignored", token: watch, transport: "http" });
    await aliceWatch.connect(conversationId);
    await aliceWatch.waitFor("burst-end");
    bobClient.close();
    aliceWatch.close();
    await new Promise((r) => setTimeout(r, 80));
    const record = sink.of("oao.conversation").find((e) => e.conversationId === conversationId)!;
    assert.deepEqual([record.outcome, record.from, record.to, record.delivered], ["answered", bob.user.id, alice.user.id, true]);

    // The watch's upload becomes a summary under its account and device, from its token.
    const t0 = Date.now();
    const upload = await call("POST", "/v1/metrics", watch, {
      conversationId, userId: "someone-else", role: "receiver", clockOffsetMs: 0,
      device: { platform: "watch", build: "77<script>" },
      events: [{ name: "answerTapped", t: t0, detail: "notification" }, { name: "firstAudioScheduled", t: t0 + 600 }],
    });
    assert.equal(upload.status, 200);
    const summary = sink.of("oao.device").at(-1)!;
    assert.deepEqual([summary.userId, summary.deviceId, summary.platform, summary.build], [alice.user.id, "alice-watch", "watch", "77script"]);
    assert.equal((summary.intervals as Record<string, number>).tapToFirstAudioMs, 600);

    // Device events.
    const events = await call("POST", "/v1/events", alice.token, { device: { platform: "iphone", build: "77" }, events: [{ name: "pttLeft", t: t0, fields: { reason: 1 } }, { name: "crash", fields: { signal: "SIGSEGV" } }] });
    assert.deepEqual(events.body, { accepted: 2 });
    assert.deepEqual(sink.of("oao.event").map((e) => [e.name, e.userId, e.severity]), [["pttLeft", alice.user.id, "INFO"], ["crash", alice.user.id, "WARNING"]]);

    // A problem report asks both devices for their logs; the note stays out of the logs.
    assert.equal((await call("GET", "/v1/me", alice.token)).body.diagnosticsRequestedAt, undefined);
    const feedback = await call("POST", "/v1/feedback", alice.token, { note: "Bob's ring didn't play", build: "77", platform: "iphone" });
    assert.equal(feedback.status, 200);
    assert.match(lines.find((l) => l.startsWith("[feedback]"))!, new RegExp(`^\\[feedback\\] ${feedback.body.id}: ${alice.user.id}, with diagnostics$`));
    assert.doesNotMatch(JSON.stringify(sink.entries), /didn't play/);
    const requestedAt = (await call("GET", "/v1/me", watch)).body.diagnosticsRequestedAt;
    assert.equal(typeof requestedAt, "number");

    // The watch answers with its log.
    const log = gzipSync(JSON.stringify({ name: "launch" }) + "\n");
    const sent = await call("POST", "/v1/diagnostics", watch, log, { "content-type": "application/gzip", "x-oao-platform": "watch", "x-oao-build": "77" });
    assert.equal(sent.status, 200);
    const [stored] = await docs.getAll([`diagnostics/${sent.body.id}`]);
    assert.deepEqual([stored!.userId, stored!.deviceId, stored!.platform, stored!.size, stored!.encoding], [alice.user.id, "alice-watch", "watch", log.length, "gzip"]);
    assert.ok(Buffer.from(stored!.log as Uint8Array).equals(log));
    // The apps send raw DEFLATE (NSData's .zlib).
    const raw = await call("POST", "/v1/diagnostics", alice.token, deflateRawSync("{}\n"), { "content-type": "application/octet-stream" });
    assert.equal((await docs.getAll([`diagnostics/${raw.body.id}`]))[0]!.encoding, "deflate-raw");
    const tooBig = await call("POST", "/v1/diagnostics", watch, Buffer.alloc(950 * 1024), { "content-type": "application/gzip" });
    assert.deepEqual([tooBig.status, tooBig.body.error], [413, "diagnostics-too-large"]);

    // Errors are entries with the route's template, never its IDs.
    await call("PATCH", "/v1/friends/u_nobody", alice.token, { favorite: true });
    const error = sink.of("oao.api").find((e) => e.status === 404 && e.route === "/v1/friends/{id}")!;
    assert.deepEqual([error.method, error.error, error.userId], ["PATCH", "not-friends", alice.user.id]);

    // Usage actions: IDs and fields, never names.
    const actions = sink.of("oao.action");
    assert.deepEqual(actions.map((a) => a.action), ["account_created", "device_added", "account_created", "invite_created", "invite_accepted"]);
    const accepted = actions.find((a) => a.action === "invite_accepted")!;
    assert.deepEqual([accepted.userId, accepted.inviter, typeof accepted.inviteAgeMs], [bob.user.id, alice.user.id, "number"]);
    assert.doesNotMatch(JSON.stringify(actions), /Alice|Bob/);

    // Deleting the account deletes its diagnostics and problem reports.
    assert.equal((await call("DELETE", "/v1/me", alice.token, {})).status, 200);
    assert.deepEqual(await docs.getAll([`diagnostics/${sent.body.id}`, `diagnostics/${raw.body.id}`, `feedback/${feedback.body.id}`]), [undefined, undefined, undefined]);
  } finally {
    await running.close();
  }
});
