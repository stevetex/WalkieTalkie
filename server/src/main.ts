// Spike server: HTTP API for device registration and metrics, plus the relay WebSocket.
//
//   PORT              listen port (default 8080)
//   HOST              listen address (default: all interfaces; 127.0.0.1 behind a proxy)
//   STORE             "json" (default) or "firestore"
//   DATA_DIR          json store: where devices.json and metrics.jsonl live (default ./data)
//   FIRESTORE_PROJECT firestore store: the project (default: the VM's, from the metadata server)
//   FIRESTORE_EMULATOR_HOST
//                     firestore store: host:port of the Firestore emulator instead of Google Cloud
//   FIRESTORE_AUTH    firestore store: "gcloud" uses the gcloud CLI's account instead of the VM's
//                     service account (local runs against the real database)
//   SPIKE_TOKEN       the shared relay token: clients without accounts (the spike's model) and
//                     the diagnostics endpoints. Unset = no auth for those (local only)
//   SESSION_PUBLIC_KEYS  JSON {kid: PEM} of Ed25519 keys that sign session tokens (see
//                     session.ts); with it, clients can connect with an account's token.
//                     SESSION_PUBLIC_KEYS_SECRET names a Secret Manager secret instead
//   SERVE_API         1 = also serve the account API (api.ts) on this port, for local runs.
//                     Its settings are api-main.ts's; without SESSION_SIGNING_KEY a key is
//                     generated and kept in DATA_DIR/session-key.json
//   APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//                     APNs token auth; if any is missing, pushes are logged (dry run)
//   SPIKE_TOKEN_SECRET, APNS_KEY_SECRET
//                     relay nodes: Secret Manager secret IDs to read SPIKE_TOKEN and APNS_KEY
//                     (the .p8 key's text) from
//   PREFETCH_PUSH_MS  prototype: send a prefetch push this long after an APNs ring (or when the
//                     sender's first burst ends, if sooner); unset or 0 = off (see prefetchAlert)
//   DRAIN_MS          on SIGTERM, how long to let open conversations finish (default 0)
//   REVISION          the git commit, reported by /healthz
//   SIMULATOR_PUSH    1 = deliver rings to simulators on this Mac with simctl (development
//                     only; see simulator.ts)

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join, resolve } from "node:path";
import { acceptUpgrade, rejectUpgrade } from "./ws.ts";
import { ApnsPusher, DryRunPusher, apnsConfigFromEnv, type Pusher } from "./apns.ts";
import { SimulatorPusher } from "./simulator.ts";
import {
  FirestoreDeviceStore,
  FirestoreMetricsStore,
  JsonDeviceStore,
  JsonMetricsStore,
  ensureDir,
  type DeviceStore,
  type MetricsStore,
} from "./store.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { loadSecrets } from "./secrets.ts";
import { Relay, type Peer } from "./relay.ts";
import { summarizeAttempts } from "./report.ts";
import { RecordParser, RecordType, encodeJSONRecord, encodeRecord } from "./records.ts";
import type { ClientMessage, MetricsUpload } from "./protocol.ts";
import { SessionVerifier, parsePublicKeys } from "./session.ts";
import { bearer, type ApiHandler } from "./api.ts";
import { Accounts, USER_ID_PREFIX } from "./accounts.ts";
import { apiFromEnv, type ApiSetup } from "./api-main.ts";
import { MemoryDocs } from "./docs.ts";

export interface ServerOptions {
  port: number;
  host?: string;
  // The JSON stores' directory; null keeps them in memory. Ignored for stores passed in.
  dataDir: string | null;
  devices?: DeviceStore;
  metrics?: MetricsStore;
  token: string | null;
  // Verifies account session tokens; null or absent = only the shared token works.
  sessions?: SessionVerifier | null;
  // Friend checks for accounts' rings.
  accounts?: Accounts;
  // The account API, served on the same port (local runs).
  api?: ApiHandler;
  pusher: Pusher;
  ringTimeoutMs?: number;
  answerJoinTimeoutMs?: number;
  prefetchPushAfterMs?: number;
}

export interface RunningServer {
  server: Server;
  relay: Relay;
  devices: DeviceStore;
  metrics: MetricsStore;
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const devices = options.devices ?? new JsonDeviceStore(options.dataDir);
  const metrics = options.metrics ?? new JsonMetricsStore(options.dataDir);
  const relay = new Relay({
    devices,
    ...(options.accounts ? { accounts: options.accounts } : {}),
    pusher: options.pusher,
    metrics,
    ...(options.ringTimeoutMs ? { ringTimeoutMs: options.ringTimeoutMs } : {}),
    ...(options.answerJoinTimeoutMs ? { answerJoinTimeoutMs: options.answerJoinTimeoutMs } : {}),
    ...(options.prefetchPushAfterMs ? { prefetchPushAfterMs: options.prefetchPushAfterMs } : {}),
  });

  // Who's calling: an account (its user ID from the session token), or a client with the
  // shared token, which names its own user ID. Null = unauthorized.
  const authenticate = (req: IncomingMessage, url: URL): Caller | null => {
    const presented = bearer(req) ?? url.searchParams.get("token");
    if (presented && options.sessions && presented.split(".").length === 3) {
      try {
        return { account: true, userId: options.sessions.verify(presented).sub };
      } catch {
        return null;
      }
    }
    if (options.token && presented !== options.token) return null;
    // Shared-token clients can't claim an account's user ID.
    const userId = url.searchParams.get("userId");
    if (userId?.startsWith(USER_ID_PREFIX)) return null;
    return { account: false, userId };
  };

  const sockets = new Set<ReturnType<typeof acceptUpgrade>>();
  // HTTP transport peers by user, so a POST can find the stream it belongs to.
  const streams = new Map<string, { peer: Peer; res: ServerResponse }>();

  // GET /v1/relay/stream: the server-to-client half of the HTTP transport. The response
  // stays open for the conversation and carries the same messages as the WebSocket.
  const openStream = (req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): void => {
    const userId = caller.userId;
    if (!userId) return send(res, 400, { error: "userId is required" });
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const peer: Peer = {
      userId,
      account: caller.account,
      sendJSON: (m) => void res.write(encodeJSONRecord(m)),
      sendBinary: (b) => void res.write(encodeRecord(RecordType.audio, b)),
    };
    streams.get(userId)?.res.end();
    streams.set(userId, { peer, res });
    relay.connect(peer);
    console.log(`[relay] ${userId} connected (http)`);
    // The stream's first message doubles as hello-ack for clock-offset estimates.
    const clientTime = Number(url.searchParams.get("clientTime") ?? 0);
    peer.sendJSON({ type: "hello-ack", clientTime, serverTime: Date.now() });
    // ?join=<conversationId> answers and joins in this same request, saving the watch two
    // round trips on a network that's still waking up (option C: the notification carries
    // the ID). "pending" joins the user's newest queued ring (see Relay.join).
    const join = url.searchParams.get("join");
    if (join) relay.handleMessage(peer, { type: "join", conversationId: join });
    // Keepalive, so idle proxies and carrier NATs don't drop the connection.
    const ping = setInterval(() => peer.sendJSON({ type: "ping" }), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      if (streams.get(userId)?.peer === peer) streams.delete(userId);
      relay.disconnect(peer);
      console.log(`[relay] ${userId} disconnected (http)`);
    });
  };

  // POST /v1/relay/send: the client-to-server half. Each body is a batch of records
  // (control messages and audio frames), applied in order.
  const receiveRecords = async (req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> => {
    const stream = streams.get(caller.userId ?? "");
    if (!stream) return send(res, 409, { error: "open GET /v1/relay/stream first" });
    const parser = new RecordParser();
    for await (const chunk of req) {
      for (const record of parser.push(chunk as Buffer)) {
        if (record.type === RecordType.audio) {
          relay.handleAudio(stream.peer, record.payload);
        } else {
          relay.handleMessage(stream.peer, JSON.parse(record.payload.toString("utf8")) as ClientMessage);
        }
      }
    }
    send(res, 200, {});
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, revision: process.env.REVISION ?? "local" });
      if (options.api && (await options.api(req, res, url))) return;
      const caller = authenticate(req, url);
      if (!caller) return send(res, 401, { error: "unauthorized" });
      // Registration, the device list and diagnostics are for shared-token clients only.
      // Accounts register with the account API.
      const sharedOnly = ["/v1/devices", "/v1/users", "/v1/status"].includes(url.pathname) ||
        (req.method === "GET" && url.pathname.startsWith("/v1/metrics"));
      if (sharedOnly && caller.account) return send(res, 403, { error: "forbidden" });

      if (req.method === "POST" && url.pathname === "/v1/devices") {
        const body = await readJSON(req);
        const { userId, name, apnsEnvironment, ...rest } = body as Record<string, unknown>;
        // The spike watch app still sends its token as voipToken.
        const pushToken = rest.pushToken ?? rest.voipToken;
        if (typeof userId !== "string" || !userId || typeof pushToken !== "string" || !pushToken) {
          return send(res, 400, { error: "userId and pushToken are required" });
        }
        if (userId.startsWith(USER_ID_PREFIX)) return send(res, 403, { error: "forbidden" });
        await devices.upsert({
          userId,
          name: typeof name === "string" && name ? name : userId,
          pushToken,
          apnsEnvironment: apnsEnvironment === "production" ? "production" : "sandbox",
          updatedAt: Date.now(),
        });
        console.log(`[api] registered ${userId} (${apnsEnvironment ?? "sandbox"})`);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/users") {
        return send(res, 200, (await devices.list()).map((d) => ({ userId: d.userId, name: d.name })));
      }
      if (req.method === "POST" && url.pathname === "/v1/metrics") {
        const upload = (await readJSON(req)) as MetricsUpload;
        if (!upload?.conversationId || !Array.isArray(upload.events)) return send(res, 400, { error: "bad metrics" });
        if (caller.account) upload.userId = caller.userId!;
        await metrics.upload(upload);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/metrics") {
        return send(res, 200, await metrics.conversations());
      }
      const match = url.pathname.match(/^\/v1\/metrics\/([\w-]+)$/);
      if (req.method === "GET" && match) {
        const timeline = await metrics.timeline(match[1]);
        return send(res, 200, { conversationId: match[1], timeline, attempts: summarizeAttempts(timeline) });
      }
      if (req.method === "GET" && url.pathname === "/v1/status") return send(res, 200, relay.snapshot());
      // Clock-offset sampling: clients time the round trip and keep the fastest sample.
      if (req.method === "GET" && url.pathname === "/v1/time") return send(res, 200, { serverTime: Date.now() });
      // The watch answered a ring. Sent over HTTPS because the relay socket can take
      // several seconds to open after the call starts.
      if (req.method === "POST" && url.pathname === "/v1/rings/answer") {
        const body = (await readJSON(req)) as Record<string, unknown>;
        const userId = caller.account ? caller.userId : body.userId;
        const conversationId = body.conversationId;
        if (typeof userId !== "string" || typeof conversationId !== "string") {
          return send(res, 400, { error: "userId and conversationId are required" });
        }
        return send(res, relay.answered(userId, conversationId) ? 200 : 404, {});
      }
      if (req.method === "GET" && url.pathname === "/v1/relay/stream") return openStream(req, res, url, caller);
      if (req.method === "POST" && url.pathname === "/v1/relay/send") return await receiveRecords(req, res, caller);
      // Prototype: the message a ring is holding, for the watch's notification service
      // extension to download before the tap (see Relay.bufferedAudio).
      if (req.method === "GET" && url.pathname === "/v1/rings/audio") {
        const audio = relay.bufferedAudio(caller.userId ?? "", url.searchParams.get("conversationId") ?? "");
        if (!audio) return send(res, 404, { error: "unknown conversation" });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
          "x-bursts": String(audio.bursts),
          "x-frames": String(audio.frames),
        });
        return void res.end(audio.records);
      }
      // For devices registered with a "poll:" token (no VoIP push): collect pending rings.
      if (req.method === "GET" && url.pathname === "/v1/rings/poll") {
        return send(res, 200, relay.takePolledRings(caller.userId ?? ""));
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/relay") return rejectUpgrade(socket, 404, "Not Found");
    const caller = authenticate(req, url);
    if (!caller) return rejectUpgrade(socket, 401, "Unauthorized");
    const userId = caller.userId;
    if (!userId) return rejectUpgrade(socket, 400, "Bad Request");
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    sockets.add(ws);

    const peer: Peer = { userId, account: caller.account, sendJSON: (m) => ws.sendJSON(m), sendBinary: (b) => ws.sendBinary(b) };
    relay.connect(peer);
    console.log(`[relay] ${userId} connected`);
    ws.on("text", (text: string) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(text);
      } catch {
        return ws.sendJSON({ type: "error", message: "invalid JSON" });
      }
      relay.handleMessage(peer, message);
    });
    ws.on("binary", (frame: Buffer) => relay.handleAudio(peer, frame));
    ws.on("close", () => {
      sockets.delete(ws);
      relay.disconnect(peer);
      console.log(`[relay] ${userId} disconnected`);
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
        devices,
        metrics,
        port,
        close: () =>
          new Promise<void>((done) => {
            relay.close();
            options.pusher.close();
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
  account: boolean;
  // From the session token for accounts; from the request (?userId=) otherwise.
  userId: string | null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
  const token = env.SPIKE_TOKEN || null;
  const host = env.HOST || undefined;
  const port = Number(env.PORT ?? 8080);
  const prefetchPushAfterMs = Number(env.PREFETCH_PUSH_MS ?? 0);
  let sessions = env.SESSION_PUBLIC_KEYS ? new SessionVerifier(parsePublicKeys(env.SESSION_PUBLIC_KEYS)) : null;
  let running: RunningServer;
  let api: ApiSetup | null = null;
  if (env.STORE === "firestore") {
    const db = new Firestore({ projectId, emulatorHost, accessToken });
    const devices = new FirestoreDeviceStore(db);
    const metrics = new FirestoreMetricsStore(db);
    if (env.SERVE_API === "1") api = apiFromEnv(env, db, null);
    const accounts = api?.accounts ?? new Accounts(db);
    sessions = api?.verifier ?? sessions;
    running = await startServer({ port, host, dataDir: null, devices, metrics, token, sessions, accounts, api: api?.handler, pusher, prefetchPushAfterMs });
    console.log(`[server] listening on ${host ?? ""}:${running.port}, data in Firestore ${emulatorHost ? `emulator ${emulatorHost}, ` : ""}project ${projectId}`);
  } else {
    const dataDir = ensureDir(resolve(env.DATA_DIR ?? "data"));
    // Accounts are only kept locally when this process also serves the API.
    if (env.SERVE_API === "1") api = apiFromEnv(env, new MemoryDocs(join(dataDir, "accounts.json")), dataDir);
    sessions = api?.verifier ?? sessions;
    running = await startServer({ port, host, dataDir, token, sessions, accounts: api?.accounts, api: api?.handler, pusher, prefetchPushAfterMs });
    console.log(`[server] listening on ${host ?? ""}:${running.port}, data in ${dataDir}`);
  }
  for (const note of api?.notes ?? []) console.log(`[api] ${note}`);
  if (sessions) console.log("[server] accounts can connect with session tokens");
  console.log(`[server] revision ${env.REVISION ?? "local"}${secrets.length ? `, secrets ${secrets.join(", ")} from Secret Manager` : ""}`);
  console.log(apnsConfig ? `[server] APNs alert pushes, topic ${apnsConfig.bundleId}` : "[server] APNs not configured: dry-run pushes");
  if (prefetchPushAfterMs) console.log(`[server] prefetch pushes ${prefetchPushAfterMs} ms after a ring (prototype)`);
  if (simulatorPush) console.warn("[server] SIMULATOR_PUSH: rings to simulator tokens run xcrun simctl push");
  if (!token) console.warn("[server] SPIKE_TOKEN not set: API and relay are unauthenticated");
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
