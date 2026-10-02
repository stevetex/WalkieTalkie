// The relay node: the relay over WebSocket and HTTPS, ring calls and timelines for accounts
// (contracts/README.md, "The relay"), and the operator's diagnostics. Every relay path is /v2: it
// needs an account's session token, checks the stored session, and admits a client by its kind,
// build, relay protocol and codecs before it opens a stream or joins anything.
//
//   PORT              listen port (default 8080)
//   HOST              listen address (default: all interfaces; 127.0.0.1 behind a proxy)
//   STORE             "json" (default) or "firestore"
//   DATA_DIR          json store: where metrics.jsonl, telemetry.jsonl and (with SERVE_API)
//                     accounts.json live (default ./data)
//   FIRESTORE_PROJECT firestore store: the project (default: the VM's, from the metadata server)
//   FIRESTORE_EMULATOR_HOST
//                     firestore store: host:port of the Firestore emulator instead of Google Cloud
//   FIRESTORE_AUTH    firestore store: "gcloud" uses the gcloud CLI's account instead of the VM's
//                     service account (local runs against the real database)
//   SPIKE_TOKEN       the operator's diagnostics token, for /admin/status and /admin/metrics
//                     (tools/report.ts, beta.ts). Unset = no auth for those (local only)
//   OPS_STATS_TOKEN   the Ops dashboard's token: it opens /admin/stats (totals and anonymous rows)
//                     and nothing else, and SPIKE_TOKEN doesn't open that. OPS_STATS_TOKEN_SECRET
//                     names a Secret Manager secret instead. Unset: /admin/stats is open only on
//                     a relay without SPIKE_TOKEN (local)
//   CANARY_USER_ID    the Canary account (rolling-main.ts): /admin/stats leaves out its connections
//                     and conversations, as it does the Test Bot's connections
//   NODE_NAME         this node's name in /admin/stats (default: the host name)
//   SESSION_PUBLIC_KEYS  JSON {kid: PEM} of Ed25519 keys that sign session tokens (see
//                     session.ts). SESSION_PUBLIC_KEYS_SECRET names a Secret Manager secret instead
//   SERVE_API         1 = also serve the account API (api.ts) on this port, for local runs.
//                     Its settings are api-main.ts's; without SESSION_SIGNING_KEY a key is
//                     generated and kept in DATA_DIR/session-key.json. A json store needs it:
//                     the relay can't run without accounts
//   APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//                     APNs token auth; if any is missing, pushes are logged (dry run)
//   SPIKE_TOKEN_SECRET, APNS_KEY_SECRET
//                     relay nodes: Secret Manager secret IDs to read SPIKE_TOKEN and APNS_KEY
//                     (the .p8 key's text) from
//   PREFETCH_PUSH_MS  prototype: send a prefetch push this long after an APNs ring (or when the
//                     sender's first burst ends, if sooner); unset or 0 = off (see prefetchAlert)
//   DRAIN_MS          on SIGTERM, how long to let open conversations finish (default 0)
//   RING_TIMEOUT_MS   how long an unanswered ring waits (default 35 s). Local runs only (the
//                     performance suite shortens it); refused on Google Cloud
//   REVISION          the git commit, reported by /healthz
//   SIMULATOR_PUSH    1 = deliver rings to simulators on this Mac with simctl (development
//                     only; see simulator.ts)
//   FULL_TIMELINE_USERS
//                     comma-separated account IDs whose devices' whole timelines are logged, not
//                     only their summaries (telemetry.ts)
//   MINIMUM_BUILDS    JSON {clientKind: build}: relay admission refuses older builds with 409
//                     client-upgrade-required (contracts/README.md). Unset = no minimum
//   FCM_STUB          1 = rings to Android devices are recorded instead of sent (local runs only;
//                     there's no FCM until Phase 2)
//   TEST_BOT_USER_ID  the Test Bot's account: it answers rings inside this process, greets and
//                     says each burst back (test-bot.ts). Unset = no bot. With SERVE_API=1,
//                     TEST_BOT_INVITE also works here (see api-main.ts)
//
// Telemetry: on Google Cloud, structured entries go to Cloud Logging (log oao-telemetry);
// locally, to DATA_DIR/telemetry.jsonl.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { MAX_QUEUED_BYTES, acceptUpgrade, rejectUpgrade } from "./ws.ts";
import { ApnsPusher, DryRunPusher, apnsConfigFromEnv, type Pusher } from "./apns.ts";
import { SimulatorPusher } from "./simulator.ts";
import { JsonMetricsStore, ensureDir, type MetricsStore } from "./store.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { loadSecrets } from "./secrets.ts";
import { Relay, type Peer, type RingCallResult } from "./relay.ts";
import { TestBot, loadGreeting, type TestBotOptions } from "./test-bot.ts";
import { summarizeAttempts } from "./report.ts";
import { RecordParser, RecordType, encodeJSONRecord, encodeRecord } from "./records.ts";
import { isRingId, parseClientMessage, type MetricsUpload, type RelayErrorCode } from "./protocol.ts";
import { SessionVerifier, parsePublicKeys, type SessionClaims } from "./session.ts";
import { bearer, type ApiHandler } from "./api.ts";
import { Accounts } from "./accounts.ts";
import { apiFromEnv, type ApiSetup } from "./api-main.ts";
import { MemoryDocs } from "./docs.ts";
import { CloudLoggingSink, FileSink, StdoutSink, TelemetryMetricsStore, type DeviceInfo, type LogSink } from "./telemetry.ts";
import { ContractError, parseAdmission, parseMinimumBuilds, type Admission, type MinimumBuilds } from "./contract.ts";
import { ApnsDelivery, Deliveries, FcmStub } from "./delivery.ts";
import { SessionGate } from "./session-gate.ts";

export interface ServerOptions {
  port: number;
  host?: string;
  // The JSON metrics store's directory; null keeps it in memory. Ignored for a store passed in.
  dataDir: string | null;
  metrics?: MetricsStore;
  // The operator's diagnostics token (/admin/…); null = no auth for those (local only).
  adminToken: string | null;
  // The Ops dashboard's token, for /admin/stats only.
  opsStatsToken?: string | null;
  // Left out of /admin/stats (RelayOptions).
  canaryUserId?: string;
  // This node in /admin/stats.
  node?: string;
  // Verifies account session tokens.
  sessions: SessionVerifier;
  // Friend checks for rings, and the stored sessions the relay checks.
  accounts: Accounts;
  // The account API, served on the same port (local runs).
  api?: ApiHandler;
  pusher: Pusher;
  // Ring deliveries by provider; default APNs through `pusher` (tests add the FCM stub).
  deliveries?: Deliveries;
  // Relay errors as structured entries (telemetry.ts); none = console only.
  telemetry?: LogSink;
  // The lowest build of each client kind admitted (MINIMUM_BUILDS); none = no minimum.
  minimumBuilds?: MinimumBuilds;
  // How old a session check may be at admission, and how often an open connection is checked
  // again (default 10 s).
  sessionCheckMs?: number;
  ringTimeoutMs?: number;
  answerJoinTimeoutMs?: number;
  rollOverMs?: number;
  prefetchPushAfterMs?: number;
  // Relay limits (see RelayOptions); tests shorten them.
  authTtlMs?: number;
  maxBurstMs?: number;
  maxBufferedBytes?: number;
  // The always-on Test Bot (test-bot.ts).
  testBot?: TestBotOptions;
}

export interface RunningServer {
  server: Server;
  relay: Relay;
  testBot: TestBot | null;
  metrics: MetricsStore;
  sessionGate: SessionGate;
  port: number;
  close(): Promise<void>;
}

// A refusal with a stable code (contracts/README.md, "Errors").
class Refusal extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error));
    this.status = status;
    this.body = body;
  }
}

const RING_ERROR_STATUS: Record<RelayErrorCode, number> = {
  "ring-expired": 410,
  "ring-answered-elsewhere": 409,
  "unknown-conversation": 404,
  "unsupported-codec": 409,
  "burst-too-long": 400,
  "too-much-audio": 400,
  "unknown-message": 400,
};

const RING_ERROR_MESSAGE: Partial<Record<RelayErrorCode, string>> = {
  "ring-expired": "This conversation has expired.",
  "ring-answered-elsewhere": "Answered on another device.",
};

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const metrics = options.metrics ?? new JsonMetricsStore(options.dataDir);
  const deliveries = options.deliveries ?? new Deliveries({ apns: new ApnsDelivery(options.pusher) });
  const relay = new Relay({
    accounts: options.accounts,
    pusher: options.pusher,
    deliveries,
    metrics,
    ...(options.ringTimeoutMs ? { ringTimeoutMs: options.ringTimeoutMs } : {}),
    ...(options.answerJoinTimeoutMs ? { answerJoinTimeoutMs: options.answerJoinTimeoutMs } : {}),
    ...(options.rollOverMs ? { rollOverMs: options.rollOverMs } : {}),
    ...(options.prefetchPushAfterMs ? { prefetchPushAfterMs: options.prefetchPushAfterMs } : {}),
    ...(options.authTtlMs !== undefined ? { authTtlMs: options.authTtlMs } : {}),
    ...(options.maxBurstMs ? { maxBurstMs: options.maxBurstMs } : {}),
    ...(options.maxBufferedBytes ? { maxBufferedBytes: options.maxBufferedBytes } : {}),
    ...(options.testBot ? { testBotUserId: options.testBot.userId } : {}),
    ...(options.canaryUserId ? { canaryUserId: options.canaryUserId } : {}),
  });
  const startedAt = Date.now();
  const testBot = options.testBot ? new TestBot(relay, metrics, options.testBot) : null;
  testBot?.start();
  const minimumBuilds = options.minimumBuilds ?? {};
  const gate = new SessionGate(options.accounts, { ttlMs: options.sessionCheckMs ?? 10_000 });

  // The caller's session token, checked for its signature and expiry. Null = unauthorized.
  const authenticate = (req: IncomingMessage): Caller | null => {
    const token = bearer(req);
    if (!token) return null;
    try {
      const claims = options.sessions.verify(token);
      return { userId: claims.sub, deviceId: claims.dev, claims };
    } catch {
      return null;
    }
  };

  // The session must still be current (a sign-out, a revoked watch or a deleted account ends
  // it, whatever the token says). Fails closed: a lookup that fails refuses the request.
  const admitSession = async (caller: Caller): Promise<void> => {
    let session;
    try {
      session = await gate.admit(caller.claims);
    } catch (err) {
      console.error(`[relay] checking ${caller.userId}'s session failed: ${(err as Error).message}`);
      throw new Refusal(503, { error: "temporarily-unavailable", message: "Try again in a moment." });
    }
    if (!session) throw new Refusal(401, { error: "session-ended", message: "session-ended" });
    caller.session = session;
  };

  // Admission (contracts/README.md, "The relay"): the client's kind, build, relay protocol and
  // codecs, before it opens a stream or joins anything.
  const admit = (req: IncomingMessage, caller: Caller): Admission => {
    try {
      const admission = parseAdmission((name) => headerValue(req, name), minimumBuilds);
      if (caller.session && caller.session.clientKind !== admission.clientKind) {
        throw new ContractError(400, "client-kind-mismatch", `this session is for a ${caller.session.clientKind} device`);
      }
      return admission;
    } catch (err) {
      if (!(err instanceof ContractError)) throw err;
      options.telemetry?.write({ kind: "oao.admission", userId: caller.userId, deviceId: caller.deviceId, error: err.code, clientKind: headerValue(req, "x-oao-client-kind") ?? null, build: headerValue(req, "x-oao-build") ?? null, protocol: headerValue(req, "x-oao-relay-protocol") ?? null }, "WARNING");
      throw new Refusal(err.status, { error: err.code, message: err.message, ...err.detail });
    }
  };

  const sockets = new Set<ReturnType<typeof acceptUpgrade>>();
  // HTTP transport peers by user and device, so a POST can find the stream it belongs to.
  const streams = new Map<string, { peer: Peer; res: ServerResponse }>();
  const streamKey = (caller: Caller): string => `${caller.userId}\n${caller.deviceId}`;

  // An open connection is checked again every sessionCheckMs; once its session has ended it's
  // told and closed.
  const watchSession = (caller: Caller, peer: Peer, close: () => void): (() => void) => {
    const claims = caller.claims;
    const timer = setInterval(() => {
      void gate.stillActive(claims).then((active) => {
        if (active) return;
        console.log(`[relay] ${peer.userId} (${peer.deviceId}): session ended, closing`);
        peer.sendJSON({ type: "session-ended" });
        close();
      });
    }, gate.checkIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  };

  // GET /v2/relay/stream: the server-to-client half of the HTTP transport. The response stays
  // open for the conversation and carries the same messages as the WebSocket.
  const openStream = (req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller, admission: Admission): void => {
    const key = streamKey(caller);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    // A client that stops reading is dropped rather than queueing its audio without limit.
    const write = (record: Buffer): void => {
      if (res.writableLength > MAX_QUEUED_BYTES) return void res.destroy();
      res.write(record);
    };
    const peer: Peer = {
      userId: caller.userId,
      deviceId: caller.deviceId,
      clientKind: admission.clientKind,
      decode: admission.decode,
      sendJSON: (m) => write(encodeJSONRecord(m)),
      sendBinary: (b) => write(encodeRecord(RecordType.audio, b)),
    };
    streams.get(key)?.res.end();
    streams.set(key, { peer, res });
    relay.connect(peer);
    console.log(`[relay] ${peer.userId} (${peer.deviceId}) connected (http, ${admission.clientKind} ${admission.build})`);
    // The stream's first message doubles as hello-ack for clock-offset estimates.
    const clientTime = Number(url.searchParams.get("clientTime") ?? 0);
    peer.sendJSON({ type: "hello-ack", clientTime, serverTime: Date.now() });
    // ?join=<conversationId>&ring=<ringId> answers and joins in this same request, saving the
    // watch two round trips on a network that's still waking up.
    const join = url.searchParams.get("join");
    // &resumeBurst=<id>&resumeFrom=<seq>: a rejoin after the stream dropped mid-burst.
    const resumeBurst = url.searchParams.get("resumeBurst");
    const resumeFrom = Number(url.searchParams.get("resumeFrom"));
    const resume = resumeBurst && resumeBurst.length <= 128 && Number.isInteger(resumeFrom) && resumeFrom >= 0
      ? { burstId: resumeBurst, fromSeq: resumeFrom }
      : undefined;
    const ring = url.searchParams.get("ring");
    const ringId = isRingId(ring) ? ring : undefined;
    if (join) relay.handleMessage(peer, { type: "join", conversationId: join, ...(ringId ? { ringId } : {}), ...(resume ? { resume } : {}) });
    // Keepalive, so idle proxies and carrier NATs don't drop the connection.
    const ping = setInterval(() => peer.sendJSON({ type: "ping" }), 15_000);
    const unwatch = watchSession(caller, peer, () => res.end());
    req.on("close", () => {
      clearInterval(ping);
      unwatch();
      if (streams.get(key)?.peer === peer) streams.delete(key);
      relay.disconnect(peer);
      console.log(`[relay] ${peer.userId} (${peer.deviceId}) disconnected (http)`);
    });
  };

  // POST /v2/relay/send: the client-to-server half. Each body is a batch of records (control
  // messages and audio frames), applied in order.
  const receiveRecords = async (req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> => {
    const stream = streams.get(streamKey(caller));
    if (!stream) return send(res, 409, { error: "no-stream", message: "open GET /v2/relay/stream first" });
    const parser = new RecordParser();
    for await (const chunk of req) {
      for (const record of parser.push(chunk as Buffer)) {
        if (record.type === RecordType.audio) {
          relay.handleAudio(stream.peer, record.payload);
          continue;
        }
        const message = parseClientMessage(JSON.parse(record.payload.toString("utf8")));
        if (!message) return send(res, 400, { error: "bad-request", message: "invalid message" });
        relay.handleMessage(stream.peer, message);
      }
    }
    send(res, 200, {});
  };

  // POST /v2/rings/answer and /decline, GET /v2/rings/pending and /audio, after admission. Each
  // names the ring.
  const ringCall = async (req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller, path: string): Promise<void> => {
    const { userId, deviceId } = caller;
    const fail = (result: { ok: false; error: RelayErrorCode }) =>
      send(res, RING_ERROR_STATUS[result.error], { error: result.error, message: RING_ERROR_MESSAGE[result.error] ?? result.error });
    if (req.method === "GET" && path === "/rings/pending") return send(res, 200, { rings: relay.pendingRings(userId) });
    if (req.method === "GET" && path === "/rings/audio") {
      const ringId = url.searchParams.get("ringId");
      if (!isRingId(ringId)) return send(res, 400, { error: "bad-request", message: "ringId is required" });
      const audio = relay.bufferedAudio(userId, url.searchParams.get("conversationId") ?? "", ringId);
      if (!audio.ok) return fail(audio);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-bursts": String(audio.value.bursts),
        "x-frames": String(audio.value.frames),
        ...(audio.value.ring ? { "x-ring-id": audio.value.ring.ringId, "x-ring-expires-at": String(audio.value.ring.expiresAt) } : {}),
      });
      return void res.end(audio.value.records);
    }
    if (req.method === "POST" && (path === "/rings/answer" || path === "/rings/decline")) {
      const body = (await readJSON(req)) as Record<string, unknown>;
      const { conversationId, ringId } = body ?? {};
      if (typeof conversationId !== "string" || !isRingId(ringId)) {
        return send(res, 400, { error: "bad-request", message: "conversationId and ringId are required" });
      }
      const result: RingCallResult<unknown> = path === "/rings/answer"
        ? relay.answer(userId, deviceId, conversationId, ringId)
        : relay.decline(userId, conversationId, ringId);
      if (!result.ok) return fail(result);
      return send(res, 200, path === "/rings/answer" ? { ring: result.value } : {});
    }
    send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
  };

  const uploadMetrics = async (req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> => {
    const upload = (await readJSON(req)) as MetricsUpload & { device?: DeviceInfo; deviceId?: string };
    if (!upload?.conversationId || !Array.isArray(upload.events)) return send(res, 400, { error: "bad-request", message: "bad metrics" });
    upload.userId = caller.userId;
    upload.deviceId = caller.deviceId;
    upload.device = cleanDevice(upload.device);
    await metrics.upload(upload);
    send(res, 200, { ok: true });
  };

  // The Ops dashboard's live view: its own token only (never the diagnostics token, which also
  // opens /admin/status and its account IDs, and never a session token).
  const opsStats = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") return send(res, 404, { error: "not-found", message: `no route for ${req.method} /admin/stats` });
    const token = options.opsStatsToken ?? null;
    if (token ? bearer(req) !== token : options.adminToken !== null) return send(res, 401, { error: "unauthorized", message: "unauthorized" });
    res.setHeader("cache-control", "no-store");
    send(res, 200, { node: options.node ?? hostname(), revision: process.env.REVISION ?? "local", startedAt, now: Date.now(), ...relay.stats() });
  };

  // The operator's diagnostics, with the diagnostics token (never a session token).
  const admin = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (options.adminToken && bearer(req) !== options.adminToken) return send(res, 401, { error: "unauthorized", message: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/admin/status") return send(res, 200, relay.snapshot());
    if (req.method === "GET" && url.pathname === "/admin/metrics") return send(res, 200, await metrics.conversations());
    const match = url.pathname.match(/^\/admin\/metrics\/([\w-]+)$/);
    if (req.method === "GET" && match) {
      const timeline = await metrics.timeline(match[1]);
      return send(res, 200, { conversationId: match[1], timeline, attempts: summarizeAttempts(timeline) });
    }
    send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, revision: process.env.REVISION ?? "local" });
      if (options.api && (await options.api(req, res, url))) return;
      if (url.pathname === "/admin/stats") return opsStats(req, res);
      if (url.pathname.startsWith("/admin/")) return await admin(req, res, url);
      const path = url.pathname.match(/^\/v2(\/.*)$/)?.[1];
      if (!path) return send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
      const caller = authenticate(req);
      if (!caller) return send(res, 401, { error: "unauthorized", message: "unauthorized" });
      await admitSession(caller);
      if (req.method === "GET" && path === "/time") return send(res, 200, { serverTime: Date.now() });
      if (req.method === "POST" && path === "/metrics") return await uploadMetrics(req, res, caller);
      if (req.method === "GET" && path === "/relay/stream") return openStream(req, res, url, caller, admit(req, caller));
      if (req.method === "POST" && path === "/relay/send") return await receiveRecords(req, res, caller);
      if (path.startsWith("/rings/")) {
        admit(req, caller);
        return await ringCall(req, res, url, caller, path);
      }
      send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof Refusal) return send(res, err.status, err.body);
      if (url.pathname.includes("/relay") || url.pathname.endsWith("/metrics")) {
        options.telemetry?.write({ kind: "oao.relay_error", what: `${req.method} ${url.pathname}`, error: (err as Error).message.slice(0, 200) }, "ERROR");
      }
      send(res, 400, { error: "bad-request", message: (err as Error).message });
    }
  });

  server.on("upgrade", (req, socket) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/v2/relay") return rejectUpgrade(socket, 404, "Not Found");
      const caller = authenticate(req);
      if (!caller) return rejectUpgrade(socket, 401, "Unauthorized", { error: "unauthorized", message: "unauthorized" });
      let admission: Admission;
      try {
        await admitSession(caller);
        admission = admit(req, caller);
      } catch (err) {
        if (err instanceof Refusal) return rejectUpgrade(socket, err.status, "Refused", err.body);
        throw err;
      }
      const ws = acceptUpgrade(req, socket);
      if (!ws) return;
      sockets.add(ws);

      const { userId, deviceId } = caller;
      const peer: Peer = {
        userId,
        deviceId,
        clientKind: admission.clientKind,
        decode: admission.decode,
        sendJSON: (m) => ws.sendJSON(m),
        sendBinary: (b) => ws.sendBinary(b),
      };
      relay.connect(peer);
      console.log(`[relay] ${userId} (${deviceId}) connected (${admission.clientKind} ${admission.build})`);
      const unwatch = watchSession(caller, peer, () => ws.close(1008));
      // A message that breaks the relay closes this connection, not the whole node.
      const contained = (what: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          console.error(`[relay] ${userId} (${deviceId}): ${what} failed: ${(err as Error).stack ?? err}`);
          options.telemetry?.write({ kind: "oao.relay_error", what, userId, deviceId, error: (err as Error).message.slice(0, 200) }, "ERROR");
          ws.close(1011);
        }
      };
      ws.on("text", (text: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return ws.sendJSON({ type: "error", code: "unknown-message", message: "invalid JSON" });
        }
        const message = parseClientMessage(parsed);
        if (!message) return ws.sendJSON({ type: "error", code: "unknown-message", message: "invalid message" });
        contained("a message", () => relay.handleMessage(peer, message));
      });
      ws.on("binary", (frame: Buffer) => contained("an audio frame", () => relay.handleAudio(peer, frame)));
      ws.on("close", () => {
        unwatch();
        sockets.delete(ws);
        relay.disconnect(peer);
        console.log(`[relay] ${userId} (${deviceId}) disconnected`);
      });
    })().catch((err: Error) => {
      console.error(`[relay] upgrade failed: ${err.stack ?? err}`);
      rejectUpgrade(socket, 500, "Internal Server Error");
    });
  });

  // The relay stream is a long-lived response; Node's default 5-minute request timeout
  // would cut it off mid-conversation.
  server.requestTimeout = 0;

  return new Promise((resolvePromise) => {
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolvePromise({
        server,
        relay,
        testBot,
        metrics,
        sessionGate: gate,
        port,
        close: () =>
          new Promise<void>((done) => {
            testBot?.close();
            relay.close();
            deliveries.close();
            // Upgraded WebSocket sockets aren't covered by closeAllConnections().
            for (const ws of sockets) ws?.close(1001);
            for (const { res } of streams.values()) res.end();
            server.closeAllConnections();
            server.close(() => void metrics.flush().then(done));
          }),
      });
    });
  });
}

interface Caller {
  userId: string;
  deviceId: string;
  claims: SessionClaims;
  // Once admitted, the stored session.
  session?: { clientKind: string };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// What a device says about itself in its upload: short strings only.
function cleanDevice(value: unknown): DeviceInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: DeviceInfo = {};
  for (const key of ["platform", "clientKind", "model", "os", "build"] as const) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" && v) out[key] = v.replace(/[^\w .()-]/g, "").slice(0, 40);
  }
  return out;
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1 << 20) throw new Error("body too large");
  }
  return JSON.parse(raw || "{}");
}

if (import.meta.main) {
  const env = process.env;
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST || undefined;
  const onGoogleCloud = env.STORE === "firestore" && !emulatorHost && env.FIRESTORE_AUTH !== "gcloud";
  const projectId = env.FIRESTORE_PROJECT || (emulatorHost ? "demo-overandout" : onGoogleCloud ? await metadataProjectId() : "");
  const accessToken = env.FIRESTORE_AUTH === "gcloud" ? gcloudAccessToken() : metadataAccessToken();
  // Relay nodes: SPIKE_TOKEN_SECRET and APNS_KEY_SECRET name Secret Manager secrets.
  const secrets = await loadSecrets(env, projectId, accessToken);
  const apnsConfig = apnsConfigFromEnv(env);
  const apnsPusher = apnsConfig ? new ApnsPusher(apnsConfig) : new DryRunPusher();
  const simulatorPush = env.SIMULATOR_PUSH === "1";
  const pusher = simulatorPush ? new SimulatorPusher(apnsPusher) : apnsPusher;
  const adminToken = env.SPIKE_TOKEN || null;
  const opsStatsToken = env.OPS_STATS_TOKEN || null;
  const host = env.HOST || undefined;
  const port = Number(env.PORT ?? 8080);
  const prefetchPushAfterMs = Number(env.PREFETCH_PUSH_MS ?? 0);
  const minimumBuilds = parseMinimumBuilds(env.MINIMUM_BUILDS);
  // FCM_STUB: Android rings are recorded, not sent (Phase 0's later-service fixture). Never on
  // the real database: there's no FCM in production until Phase 2.
  const fcmStub = env.FCM_STUB === "1" ? new FcmStub() : null;
  if (fcmStub && onGoogleCloud) throw new Error("FCM_STUB is for local runs only");
  const deliveries = new Deliveries({ apns: new ApnsDelivery(pusher), ...(fcmStub ? { fcm: fcmStub } : {}) });
  const configuredKeys = env.SESSION_PUBLIC_KEYS ? new SessionVerifier(parsePublicKeys(env.SESSION_PUBLIC_KEYS)) : null;
  let running: RunningServer;
  let api: ApiSetup | null = null;
  const fullTimelineUsers = (env.FULL_TIMELINE_USERS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const testBot = env.TEST_BOT_USER_ID ? { userId: env.TEST_BOT_USER_ID, greeting: loadGreeting() } : undefined;
  const ringTimeoutMs = env.RING_TIMEOUT_MS ? Number(env.RING_TIMEOUT_MS) : undefined;
  if (ringTimeoutMs !== undefined && (onGoogleCloud || !(ringTimeoutMs > 0))) throw new Error("RING_TIMEOUT_MS is a positive number, for local runs only");
  const relayOptions = {
    pusher,
    deliveries,
    prefetchPushAfterMs,
    testBot,
    minimumBuilds,
    adminToken,
    opsStatsToken,
    node: env.NODE_NAME || hostname(),
    ...(env.CANARY_USER_ID ? { canaryUserId: env.CANARY_USER_ID } : {}),
    ...(ringTimeoutMs ? { ringTimeoutMs } : {}),
  };
  if (env.STORE === "firestore") {
    const db = new Firestore({ projectId, emulatorHost, accessToken });
    const telemetry: LogSink = onGoogleCloud
      ? new CloudLoggingSink({ projectId, accessToken, labels: { node: hostname(), revision: env.REVISION ?? "local" } })
      : new StdoutSink();
    const metrics = new TelemetryMetricsStore(telemetry, { fullTimelineUsers });
    if (env.SERVE_API === "1") api = apiFromEnv(env, db, null);
    const accounts = api?.accounts ?? new Accounts(db);
    const sessions = api?.verifier ?? configuredKeys;
    if (!sessions) throw new Error("SESSION_PUBLIC_KEYS (or SESSION_PUBLIC_KEYS_SECRET) is required");
    running = await startServer({ port, host, dataDir: null, metrics, telemetry, sessions, accounts, api: api?.handler, ...relayOptions });
    console.log(`[server] listening on ${host ?? ""}:${running.port}, data in Firestore ${emulatorHost ? `emulator ${emulatorHost}, ` : ""}project ${projectId}`);
  } else {
    const dataDir = ensureDir(resolve(env.DATA_DIR ?? "data"));
    // Accounts are only kept locally when this process also serves the API.
    if (env.SERVE_API !== "1") throw new Error("the relay needs accounts: STORE=firestore, or SERVE_API=1 for local accounts");
    api = apiFromEnv(env, new MemoryDocs(join(dataDir, "accounts.json")), dataDir);
    const telemetry = new FileSink(dataDir);
    const metrics = new TelemetryMetricsStore(telemetry, { inner: new JsonMetricsStore(dataDir), fullTimelineUsers });
    running = await startServer({ port, host, dataDir, metrics, telemetry, sessions: api.verifier, accounts: api.accounts, api: api.handler, ...relayOptions });
    console.log(`[server] listening on ${host ?? ""}:${running.port}, data in ${dataDir}`);
  }
  for (const note of api?.notes ?? []) console.log(`[api] ${note}`);
  console.log(`[server] revision ${env.REVISION ?? "local"}${secrets.length ? `, secrets ${secrets.join(", ")} from Secret Manager` : ""}`);
  console.log(apnsConfig ? `[server] APNs alert pushes, topic ${apnsConfig.bundleId}` : "[server] APNs not configured: dry-run pushes");
  if (prefetchPushAfterMs) console.log(`[server] prefetch pushes ${prefetchPushAfterMs} ms after a ring (prototype)`);
  if (testBot) console.log(`[server] the Test Bot ${testBot.userId} answers rings here (${testBot.greeting.length} greeting frames)`);
  if (simulatorPush) console.warn("[server] SIMULATOR_PUSH: rings to simulator tokens run xcrun simctl push");
  if (!adminToken) console.warn("[server] SPIKE_TOKEN not set: the diagnostics (/admin) are unauthenticated");
  if (!opsStatsToken && adminToken) console.log("[server] OPS_STATS_TOKEN not set: /admin/stats is closed");
  if (Object.keys(minimumBuilds).length) console.log(`[server] minimum builds ${JSON.stringify(minimumBuilds)}`);
  if (fcmStub) console.warn("[server] FCM_STUB: Android rings are recorded, not sent");
  // Container stops (deploys, autohealing) send SIGTERM. Let conversations in progress
  // finish, up to DRAIN_MS, then write buffered metrics and exit.
  const drainMs = Number(env.DRAIN_MS ?? 0);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      const deadline = Date.now() + drainMs;
      const active = () => running.relay.snapshot().length;
      if (active() && drainMs) console.log(`[server] ${signal}: draining ${active()} conversations (up to ${drainMs} ms)`);
      while (active() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      console.log(`[server] ${signal}: shutting down${active() ? ` with ${active()} conversations open` : ""}`);
      await running.close();
      process.exit(0);
    });
  }
}
