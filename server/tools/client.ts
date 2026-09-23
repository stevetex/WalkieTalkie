// Node client for the relay, used by the bot and the tests. Mirrors what the watch app does.

import { randomUUID } from "node:crypto";
import { Codec, FRAME_HEADER_BYTES, type ClientMessage, type MetricEvent, type ServerMessage } from "../src/protocol.ts";

export interface ClientOptions {
  server: string; // http(s)://host:port
  userId: string;
  token?: string;
}

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

  constructor(options: ClientOptions) {
    this.opts = options;
    this.userId = options.userId;
  }

  mark(name: string, detail?: string): void {
    this.events.push({ name, t: Date.now(), detail });
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.opts.server), {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  register(name: string, voipToken = `local:${this.userId}`): Promise<unknown> {
    return this.api("POST", "/v1/devices", { userId: this.userId, name, voipToken, apnsEnvironment: "sandbox" });
  }

  async connect(): Promise<void> {
    const url = new URL("/v1/relay", this.opts.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("userId", this.userId);
    if (this.opts.token) url.searchParams.set("token", this.opts.token);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not connect to ${url.origin}`));
    });
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as ServerMessage;
        this.received.push(message);
        this.onMessage(message);
        this.waiters = this.waiters.filter((w) => {
          if (!w.match(message)) return true;
          w.resolve(message);
          return false;
        });
      } else {
        const frame = Buffer.from(event.data as ArrayBuffer);
        this.frames.push(frame);
        this.onFrame(frame);
      }
    };
    const sentAt = Date.now();
    this.send({ type: "hello", clientTime: sentAt });
    const ack = (await this.waitFor("hello-ack")) as Extract<ServerMessage, { type: "hello-ack" }>;
    const receivedAt = Date.now();
    this.clockOffsetMs = ack.serverTime - (sentAt + receivedAt) / 2;
  }

  send(message: ClientMessage): void {
    this.ws?.send(JSON.stringify(message));
  }

  sendFrame(codec: number, seq: number, payload: Buffer): void {
    const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
    frame[0] = codec;
    frame.writeUInt32BE(seq, 1);
    payload.copy(frame, FRAME_HEADER_BYTES);
    this.ws?.send(frame);
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
    const burstId = randomUUID();
    this.mark("talkPressed");
    this.send({ type: "talk-start", to, burstId });
    const granted = await this.waitForMatch(
      (m) => (m.type === "floor-granted" || m.type === "floor-denied") && m.burstId === burstId,
      "floor decision",
    );
    if (granted.type === "floor-denied") throw new Error(`floor held by ${granted.holder}`);
    if (granted.type !== "floor-granted") throw new Error(`unexpected ${granted.type}`);
    this.mark("floorGranted", granted.pushed ? "rang recipient" : "recipient live");
    const bytesPerFrame = 320 * 2;
    const start = performance.now();
    for (let seq = 0, offset = 0; offset < pcm.length; seq++, offset += bytesPerFrame) {
      this.sendFrame(Codec.pcm16le16k, seq, pcm.subarray(offset, offset + bytesPerFrame));
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
    await this.api("POST", "/v1/metrics", {
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
  }
}
