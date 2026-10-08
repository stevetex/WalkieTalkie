// Node client for the relay (contracts/README.md, "The relay"), used by the bot, the tests and
// the performance suite. Mirrors what the apps do: an account's session token, the admission
// headers, the codec named at talk-start and the ring named when answering.

import { randomUUID } from "node:crypto";
import { Codec, FRAME_HEADER_BYTES, type ClientMessage, type MetricEvent, type ServerMessage } from "../src/protocol.ts";
import { openBundle, sealBundle, usableKeys, type FrameCipher, type FriendKeysJSON, type KeyBundle } from "../src/e2ee.ts";
import type { EndpointKeys } from "../src/endpoint-keys.ts";
import { RecordParser, RecordType, encodeJSONRecord, encodeRecord } from "../src/records.ts";

export interface ClientOptions {
  server: string; // http(s)://host:port
  // The account (the session token's), for logs and waiting messages.
  userId: string;
  token: string;
  // "ws" (default) uses the WebSocket; "http" uses the streaming GET + POST transport
  // that watches use outside a CallKit call.
  transport?: "ws" | "http";
  // What the session was made for (default watchos).
  clientKind?: "ios" | "watchos" | "android" | "wearos";
  build?: string;
  // Codecs this client plays and sends (X-OAO-Decode and X-OAO-Encode).
  decode?: string[];
  encode?: string[];
  audioFormats?: number[];
  e2ee?: { keys: EndpointKeys; directory: (userId: string) => Promise<FriendKeysJSON> };
}

// A message as it goes on the wire: talk-start names its codec ("opus16k"), where the relay's
// parsed ClientMessage carries the codec's byte.
export type WireMessage =
  | Exclude<ClientMessage, { type: "talk-start" }>
  | { type: "talk-start"; to: string; burstId: string; codec: string; format?: 1 | 2; conversationId?: string; e2ee?: KeyBundle };

type Waiter = { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void };

export class SpikeClient {
  readonly userId: string;
  readonly events: MetricEvent[] = [];
  readonly received: ServerMessage[] = [];
  readonly frames: Buffer[] = [];
  clockOffsetMs = 0;
  onMessage: (m: ServerMessage) => void = () => {};
  onFrame: (frame: Buffer) => void = () => {};

  private opts: ClientOptions;
  private ws: WebSocket | null = null;
  private waiters: Waiter[] = [];
  private stream: AbortController | null = null;
  private outbox: Buffer[] = [];
  private posting = false;
  private conversations = new Map<string, string>();
  private receiving: { format: 1 | 2; cipher: FrameCipher | null } = { format: 1, cipher: null };

  constructor(options: ClientOptions) {
    this.opts = options;
    this.userId = options.userId;
  }

  mark(name: string, detail?: string): void {
    this.events.push({ name, t: Date.now(), detail });
  }

  // The admission headers (contracts/README.md, "The relay").
  clientHeaders(): Record<string, string> {
    return {
      "x-oao-client-kind": this.opts.clientKind ?? "watchos",
      "x-oao-build": this.opts.build ?? "1",
      "x-oao-client-version": "test",
      "x-oao-relay-protocol": "2",
      "x-oao-decode": (this.opts.decode ?? ["opus16k", "pcm16le16k"]).join(","),
      "x-oao-encode": (this.opts.encode ?? ["opus16k", "pcm16le16k"]).join(","),
      ...(this.opts.audioFormats ? { "x-oao-audio-formats": this.opts.audioFormats.join(",") } : {}),
    };
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.opts.server), {
      method,
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(),
        ...this.clientHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  // `join` (HTTP transport only) joins a conversation in the request that opens the stream;
  // `ring` is the ring being answered, and `resume` (with it) rejoins after a dropped stream,
  // from that burst's first missed frame.
  async connect(join?: string, resume?: { burstId: string; fromSeq: number }, ring?: string): Promise<void> {
    if (this.opts.transport === "http") return this.connectHttp(join, resume, ring);
    const url = new URL("/v2/relay", this.opts.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Node's WebSocket takes headers (the apps' native ones do too): the token and admission.
    const ws = new WebSocket(url, { headers: { ...this.authHeaders(), ...this.clientHeaders() } } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to ${url.origin}`));
    });
    ws.onmessage = (event) => {
      if (typeof event.data === "string") this.receive(JSON.parse(event.data) as ServerMessage);
      else this.receiveFrame(Buffer.from(event.data as ArrayBuffer));
    };
    const sentAt = Date.now();
    this.send({ type: "hello", clientTime: sentAt });
    const ack = (await this.waitFor("hello-ack")) as Extract<ServerMessage, { type: "hello-ack" }>;
    const receivedAt = Date.now();
    this.clockOffsetMs = ack.serverTime - (sentAt + receivedAt) / 2;
  }

  private async connectHttp(join?: string, resume?: { burstId: string; fromSeq: number }, ring?: string): Promise<void> {
    const url = new URL("/v2/relay/stream", this.opts.server);
    if (join) url.searchParams.set("join", join);
    if (join && ring) url.searchParams.set("ring", ring);
    if (join && resume) {
      url.searchParams.set("resumeBurst", resume.burstId);
      url.searchParams.set("resumeFrom", String(resume.fromSeq));
    }
    const sentAt = Date.now();
    url.searchParams.set("clientTime", String(sentAt));
    this.stream = new AbortController();
    const res = await fetch(url, { headers: { ...this.authHeaders(), ...this.clientHeaders() }, signal: this.stream.signal });
    if (!res.ok || !res.body) throw Object.assign(new Error(`stream: HTTP ${res.status} ${await res.text()}`), { status: res.status });
    const reader = res.body.getReader();
    const parser = new RecordParser();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const record of parser.push(Buffer.from(value))) {
            if (record.type === RecordType.audio) this.receiveFrame(record.payload);
            else this.receive(JSON.parse(record.payload.toString("utf8")) as ServerMessage);
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
    const ack = (await this.waitFor("hello-ack")) as Extract<ServerMessage, { type: "hello-ack" }>;
    this.clockOffsetMs = ack.serverTime - (sentAt + Date.now()) / 2;
  }

  private receive(message: ServerMessage): void {
    if (message.type === "ping") return;
    if (message.type === "ring") this.conversations.set(message.from, message.conversationId);
    if (message.type === "joined") this.conversations.set(message.peer, message.conversationId);
    if (message.type === "burst-start") {
      this.conversations.set(message.from, message.conversationId);
      this.receiving = { format: message.format === 2 ? 2 : 1, cipher: null };
      if (message.format === 2 && message.e2ee && message.codec && this.opts.e2ee) {
        try {
          this.receiving.cipher = openBundle(message.e2ee,
            { conversationId: message.conversationId, burstId: message.burstId, codec: message.codec, from: message.from, to: this.userId },
            { deviceId: this.opts.e2ee.keys.secrets.deviceId, keys: this.opts.e2ee.keys.encryption }, Date.now()).cipher;
        } catch (error) {
          console.error(`[client] encrypted burst refused: ${(error as Error).message}`);
        }
      }
    }
    this.received.push(message);
    this.onMessage(message);
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(message)) return true;
      w.resolve(message);
      return false;
    });
  }

  private receiveFrame(frame: Buffer): void {
    if (this.receiving.format === 2) {
      if (!this.receiving.cipher) return;
      try {
        const opened = this.receiving.cipher.open(frame);
        const plain = Buffer.alloc(FRAME_HEADER_BYTES + opened.payload.length);
        plain[0] = opened.codec;
        plain.writeUInt32BE(opened.seq, 1);
        opened.payload.copy(plain, FRAME_HEADER_BYTES);
        frame = plain;
      } catch { return; }
    }
    this.frames.push(frame);
    this.onFrame(frame);
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` };
  }

  // HTTP transport uplink: records queue up and go out in back-to-back POSTs, one at a
  // time so they arrive in order.
  private enqueue(record: Buffer): void {
    this.outbox.push(record);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.posting || this.outbox.length === 0) return;
    this.posting = true;
    const body = Buffer.concat(this.outbox.splice(0));
    try {
      const url = new URL("/v2/relay/send", this.opts.server);
      const res = await fetch(url, { method: "POST", headers: this.authHeaders(), body });
      if (!res.ok) console.error(`[client] send: HTTP ${res.status}`);
    } finally {
      this.posting = false;
      void this.flush();
    }
  }

  send(message: WireMessage): void {
    if (this.opts.transport === "http") this.enqueue(encodeJSONRecord(message));
    else this.ws?.send(JSON.stringify(message));
  }

  sendFrame(codec: number, seq: number, payload: Buffer): void {
    const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
    frame[0] = codec;
    frame.writeUInt32BE(seq, 1);
    payload.copy(frame, FRAME_HEADER_BYTES);
    if (this.opts.transport === "http") this.enqueue(encodeRecord(RecordType.audio, frame));
    else this.ws?.send(frame);
  }

  waitFor<T extends ServerMessage["type"]>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return this.waitForMatch(
      (m) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>),
      type,
      timeoutMs,
    ) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  // Resolves with (and consumes) the first received or future message that matches.
  waitForMatch(match: (m: ServerMessage) => boolean, description: string, timeoutMs = 10_000): Promise<ServerMessage> {
    const already = this.received.find(match);
    if (already) {
      this.received.splice(this.received.indexOf(already), 1);
      return Promise.resolve(already);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (m) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(m), 1);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${this.userId}: timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  // Streams 16 kHz mono PCM16 in real-time 20 ms frames.
  async talk(to: string, pcm: Buffer, options: { realtime?: boolean } = {}): Promise<{ conversationId: string; pushed: boolean }> {
    const bytesPerFrame = 320 * 2;
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) frames.push(pcm.subarray(offset, offset + bytesPerFrame));
    return this.talkFrames(to, { codec: Codec.pcm16le16k, frames }, options);
  }

  // Streams already-encoded 20 ms payloads (Opus packets, or PCM frames) in real time.
  async talkFrames(
    to: string,
    audio: { codec: number; frames: Buffer[] },
    options: { realtime?: boolean } = {},
  ): Promise<{ conversationId: string; pushed: boolean }> {
    const codec = audio.codec === Codec.opus16k ? "opus16k" : "pcm16le16k";
    this.mark("talkPressed");
    let granted: ServerMessage;
    let burstId: string;
    let cipher: FrameCipher | null = null;
    for (let attempt = 0; ; attempt++) {
      cipher = null;
      burstId = randomUUID();
      const conversationId = this.conversations.get(to) ?? randomUUID();
      let bundle: KeyBundle | undefined;
      if (this.opts.e2ee) {
        const directory = await this.opts.e2ee.directory(to);
        const recipients = usableKeys(to, directory, Date.now()).recipients;
        if ((directory.devices.length || attempt > 0) && !recipients.length) throw new Error("no-current-key");
        if (recipients.length) {
          const sealed = sealBundle({ conversationId, burstId, codec, from: this.userId, to }, this.opts.e2ee.keys.sender, recipients, Date.now());
          bundle = sealed.bundle;
          cipher = sealed.cipher;
        }
      }
      this.send({ type: "talk-start", to, burstId, codec, ...(bundle ? { format: 2, conversationId, e2ee: bundle } : {}) });
      granted = await this.waitForMatch(
        (m) => (m.type === "floor-granted" || m.type === "floor-denied" || m.type === "talk-refused") && m.burstId === burstId,
        "floor decision",
      );
      if (granted.type !== "talk-refused" || granted.reason !== "keys-stale" || attempt >= 1) break;
      // The next iteration fetches the friend's current certificates and seals a new bundle.
    }
    if (granted.type === "floor-denied") throw new Error(`floor held by ${granted.holder}`);
    if (granted.type === "talk-refused") throw new Error(`refused: ${granted.reason}`);
    if (granted.type !== "floor-granted") throw new Error(`unexpected ${granted.type}`);
    this.conversations.set(to, granted.conversationId);
    this.mark("floorGranted", granted.pushed ? "rang recipient" : "recipient live");
    const start = performance.now();
    for (let seq = 0; seq < audio.frames.length; seq++) {
      this.sendFrame(audio.codec, seq, cipher ? cipher.seal(audio.codec, seq, audio.frames[seq]).subarray(FRAME_HEADER_BYTES) : audio.frames[seq]);
      if (seq === 0) this.mark("firstFrameSent");
      if (options.realtime !== false) {
        const due = start + (seq + 1) * 20;
        await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
      }
    }
    this.send({ type: "talk-end", burstId });
    this.mark("talkReleased");
    return { conversationId: granted.conversationId, pushed: granted.pushed };
  }

  async uploadMetrics(conversationId: string, role: "sender" | "receiver"): Promise<void> {
    await this.api("POST", "/v2/metrics", {
      conversationId,
      userId: this.userId,
      role,
      clockOffsetMs: this.clockOffsetMs,
      events: this.events,
    });
    this.events.length = 0;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.stream?.abort();
    this.stream = null;
  }
}
