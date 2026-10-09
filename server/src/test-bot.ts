// The always-on Test Bot (backlog: "An always-on Test Bot for reviewers"): the Test Bot's
// account as a participant inside the relay process, so App Review, and anyone else who adds
// it with its standing invite (TEST_BOT_INVITE, accounts.ts), has a friend who answers. When a
// friend rings it, it answers, plays a short greeting, then says each burst back to them once
// it ends, and leaves when they do (or after the apps' 45 s conversation window).
//
// It never rings anyone (peer.noRings): it talks only while the caller is in the conversation.
// It goes through the relay as its account, so the friendship checks apply as they do between
// people: a caller who blocks or removes it can't ring it, and a block during a conversation
// ends it.
//
// Rings reach it through the account's test delivery (tools/test-account.ts create registered
// it), which the relay rings over the account's open connection: the bot's lobby peer here,
// unless tools/bot.ts is connected as the bot at the time. It answers by joining with the
// ring's ID, and names each burst's codec at talk-start (its greeting is Opus; an echo is said
// back in the codec it came in).
//
// Each conversation gets its own peer (device relay-bot.<n>), because audio frames carry no
// conversation ID. The relay allows an account one burst at a time, so the bot talks in one
// conversation at a time and the others wait their turn.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Codec, FRAME_HEADER_BYTES, FRAME_MS, type ServerMessage } from "./protocol.ts";
import { openBundle, sealBundle, usableKeys, type FrameCipher, type FriendKeysJSON } from "./e2ee.ts";
import type { EndpointKeys } from "./endpoint-keys.ts";
import type { Peer, Relay } from "./relay.ts";
import type { MetricsStore } from "./store.ts";

// The greeting's Opus packets, made on a Mac by `node tools/bot.ts greeting` (the encoder is
// macOS's), since relay nodes can't encode.
export const GREETING_FILE = join(import.meta.dirname, "test-bot-greeting.opus");

export interface TestBotOptions {
  userId: string;
  // The lobby peer's device, which rings reach.
  deviceId?: string;
  // 20 ms Opus packets (without the frame header).
  greeting: Buffer[];
  // Ring → answer. A moment, so the caller's app has the go-ahead first.
  answerDelayMs?: number;
  // The caller's burst ends → the bot starts talking.
  replyDelayMs?: number;
  // How fast frames go out: real time (20 ms). Tests use 0: all at once.
  frameMs?: number;
  // No audio either way for this long ends the conversation, as in the apps.
  idleMs?: number;
  // What's said back is cut at this many frames (30 s).
  maxEchoFrames?: number;
  // Bursts shorter than this (a tap on Talk) aren't said back.
  minEchoFrames?: number;
  // Rings beyond this many conversations at once aren't answered.
  maxConversations?: number;
  // Its own E2EE keys (endpoint-keys.ts): it opens what it hears and seals what it says.
  keys: EndpointKeys;
  // A caller's current keys, from the key directory, to seal to.
  recipientKeys: (userId: string) => Promise<FriendKeysJSON>;
}

interface BotConversation {
  id: string;
  caller: string;
  peer: Peer;
  joined: boolean;
  // The caller's burst in progress, as it arrives; null while they're quiet.
  hearing: Buffer[] | null;
  hearingCipher: FrameCipher | null;
  seenSeq: Set<number>;
  staleRetries: number;
  // Bursts waiting to be said: frames with their headers.
  queue: Buffer[][];
  // The bot's burst the relay may still refuse (floor-denied), to say again later.
  lastSaid: { burstId: string; frames: Buffer[] } | null;
  idleTimer: NodeJS.Timeout | null;
  // Messages and frames from the relay, handled after the relay's call returns.
  inbox: Array<ServerMessage | Buffer>;
}

export class TestBot {
  private relay: Relay;
  private metrics: MetricsStore;
  private opts: Required<TestBotOptions>;
  private lobby: Peer;
  private conversations = new Map<string, BotConversation>();
  private answering = new Set<string>();
  private speaking: { conversation: BotConversation; burstId: string; frames: Buffer[]; next: number; startedAt: number; cipher: FrameCipher | null; timer: NodeJS.Timeout | null } | null = null;
  private nextPeer = 1;
  private timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(relay: Relay, metrics: MetricsStore, options: TestBotOptions) {
    this.relay = relay;
    this.metrics = metrics;
    this.opts = {
      deviceId: "test-bot",
      answerDelayMs: 500,
      replyDelayMs: 400,
      frameMs: FRAME_MS,
      idleMs: 45_000,
      maxEchoFrames: 1500,
      minEchoFrames: 10,
      maxConversations: 10,
      ...options,
    };
    this.lobby = {
      userId: this.opts.userId,
      deviceId: this.opts.deviceId,
      e2eeDeviceId: this.opts.deviceId,
      noRings: true,
      sendJSON: (m) => {
        if (m.type === "ring") this.later(0, () => this.ringed(m.conversationId, m.from, m.ringId));
      },
      sendBinary: () => {},
    };
  }

  get userId(): string {
    return this.opts.userId;
  }

  // Conversations it's in, or answering (for tests).
  get conversationCount(): number {
    return this.conversations.size + this.answering.size;
  }

  start(): void {
    this.relay.connect(this.lobby);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const conversation of [...this.conversations.values()]) this.end(conversation, false);
    this.relay.disconnect(this.lobby);
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) fn();
    }, ms);
    timer.unref();
    this.timers.add(timer);
    return timer;
  }

  private ringed(conversationId: string, caller: string, ringId: string): void {
    if (this.conversations.has(conversationId) || this.answering.has(conversationId)) return;
    if (this.conversations.size + this.answering.size >= this.opts.maxConversations) {
      console.warn(`[test-bot] not answering ${caller}: ${this.opts.maxConversations} conversations already`);
      return;
    }
    this.answering.add(conversationId);
    this.later(this.opts.answerDelayMs, () => {
      this.answering.delete(conversationId);
      const conversation: BotConversation = {
        id: conversationId,
        caller,
        peer: null as unknown as Peer,
        joined: false,
        hearing: null,
        hearingCipher: null,
        seenSeq: new Set(),
        staleRetries: 0,
        queue: [],
        lastSaid: null,
        idleTimer: null,
        inbox: [],
      };
      // The relay calls these in the middle of its own work, so they're queued and handled
      // once it's done.
      const deliver = (item: ServerMessage | Buffer): void => {
        conversation.inbox.push(item);
        if (conversation.inbox.length === 1) setImmediate(() => this.drain(conversation));
      };
      conversation.peer = {
        userId: this.opts.userId,
        deviceId: `${this.opts.deviceId}.${this.nextPeer++}`,
        e2eeDeviceId: this.opts.deviceId,
        noRings: true,
        sendJSON: (m) => deliver(m),
        sendBinary: (frame) => deliver(Buffer.from(frame)),
      };
      this.conversations.set(conversationId, conversation);
      this.relay.connect(conversation.peer);
      this.relay.handleMessage(conversation.peer, { type: "join", conversationId, ringId });
      this.resetIdle(conversation);
    });
  }

  private drain(conversation: BotConversation): void {
    const items = conversation.inbox.splice(0);
    for (const item of items) {
      if (this.conversations.get(conversation.id) !== conversation) return;
      if (Buffer.isBuffer(item)) this.heard(conversation, item);
      else this.handle(conversation, item);
    }
    this.speakNext();
  }

  private heard(conversation: BotConversation, frame: Buffer): void {
    if (!conversation.hearing || !conversation.hearingCipher || conversation.hearing.length >= this.opts.maxEchoFrames) return;
    try {
      const opened = conversation.hearingCipher.open(frame);
      if (conversation.seenSeq.has(opened.seq)) return;
      conversation.seenSeq.add(opened.seq);
      conversation.hearing.push(makeFrame(opened.codec, opened.seq, opened.payload));
    } catch {
      // A corrupt encrypted packet cannot enter the echo.
    }
  }

  private handle(conversation: BotConversation, m: ServerMessage): void {
    switch (m.type) {
      case "joined":
        conversation.joined = true;
        conversation.queue.push(this.opts.greeting.map((packet, seq) => makeFrame(Codec.opus16k, seq, packet)));
        // Marks the conversation as the bot's in telemetry (conversationRecord's testBot).
        this.metrics.server(conversation.id, "testBotAnswered", Date.now(), `${m.replayBursts} buffered`);
        break;
      case "burst-start":
        if (m.conversationId !== conversation.id || m.from !== conversation.caller) break;
        conversation.hearing = [];
        conversation.hearingCipher = null;
        conversation.seenSeq.clear();
        if (!m.codec) { conversation.hearing = null; break; }
        try {
          conversation.hearingCipher = openBundle(m.e2ee,
            { conversationId: conversation.id, burstId: m.burstId, codec: m.codec, from: m.from, to: this.opts.userId },
            { deviceId: this.opts.deviceId, keys: this.opts.keys.encryption }, Date.now()).cipher;
        } catch {
          conversation.hearing = null;
          break;
        }
        this.resetIdle(conversation);
        break;
      case "burst-end": {
        if (m.conversationId !== conversation.id || !conversation.hearing) break;
        const heard = conversation.hearing;
        conversation.hearing = null;
        conversation.hearingCipher = null;
        if (heard.length >= this.opts.minEchoFrames) conversation.queue.push(heard);
        this.resetIdle(conversation);
        break;
      }
      case "floor-denied":
        // The caller started talking first: say it after their burst instead.
        if (conversation.lastSaid?.burstId === m.burstId) {
          conversation.queue.unshift(conversation.lastSaid.frames);
          conversation.lastSaid = null;
          if (this.speaking?.burstId === m.burstId) this.stopSpeaking();
        }
        break;
      case "floor-granted":
        if (conversation.lastSaid?.burstId === m.burstId) {
          conversation.lastSaid = null;
          conversation.staleRetries = 0;
        }
        break;
      // The caller left, or they may no longer talk (a block, an unfriending, a deleted
      // account), or the caller left just as the bot started talking (talk-refused
      // "unavailable": it doesn't ring), or the ring was gone before the bot answered.
      case "peer-left":
        if (m.conversationId === conversation.id) this.end(conversation, true);
        break;
      case "conversation-ended":
        if (m.conversationId === conversation.id) this.end(conversation, false);
        break;
      case "talk-refused":
        if (m.reason === "keys-stale" && conversation.lastSaid?.burstId === m.burstId && conversation.staleRetries++ < 2) {
          conversation.queue.unshift(conversation.lastSaid.frames);
          conversation.lastSaid = null;
          if (this.speaking?.burstId === m.burstId) this.stopSpeaking();
          break;
        }
      case "moved":
        this.end(conversation, false);
        break;
      case "error":
        if (!conversation.joined) this.end(conversation, false);
        else console.warn(`[test-bot] ${conversation.id}: ${m.message}`);
        break;
    }
  }

  // One conversation talks at a time (the relay allows an account one burst at a time); the
  // longest waiting goes first.
  private speakNext(): void {
    if (this.speaking || this.closed) return;
    for (const conversation of this.conversations.values()) {
      if (!conversation.joined || conversation.hearing || !conversation.queue.length) continue;
      const frames = conversation.queue.shift()!;
      const burstId = randomUUID();
      // To the back of the line.
      this.conversations.delete(conversation.id);
      this.conversations.set(conversation.id, conversation);
      const talk = { conversation, burstId, frames, next: 0, startedAt: 0, cipher: null as FrameCipher | null, timer: null as NodeJS.Timeout | null };
      this.speaking = talk;
      conversation.lastSaid = { burstId, frames };
      talk.timer = this.later(this.opts.replyDelayMs, () => {
        talk.timer = null;
        // Quiet since: still in the conversation, and the caller hasn't started again.
        if (this.speaking !== talk) return;
        if (this.conversations.get(conversation.id) !== conversation || conversation.hearing) {
          conversation.queue.unshift(frames);
          conversation.lastSaid = null;
          return this.stopSpeaking();
        }
        // The burst's own codec: the greeting is Opus, and an echo is said back as it came.
        void this.startTalk(talk);
      });
      return;
    }
  }

  private async startTalk(talk: NonNullable<TestBot["speaking"]>): Promise<void> {
    const { conversation, frames, burstId } = talk;
    if (this.speaking !== talk) return;
    const codec = frames[0]?.[0] === Codec.pcm16le16k ? Codec.pcm16le16k : Codec.opus16k;
    try {
      const directory = await this.opts.recipientKeys(conversation.caller);
      const recipients = usableKeys(conversation.caller, directory, Date.now()).recipients;
      if (this.speaking !== talk) return;
      if (!recipients.length) return this.end(conversation, true);
      const { bundle, cipher } = sealBundle(
        { conversationId: conversation.id, burstId, codec: codec === Codec.opus16k ? "opus16k" : "pcm16le16k", from: this.opts.userId, to: conversation.caller },
        this.opts.keys.sender, recipients, Date.now());
      talk.cipher = cipher;
      this.relay.handleMessage(conversation.peer, { type: "talk-start", to: conversation.caller, burstId, codec,
        format: 2, conversationId: conversation.id, e2ee: bundle });
    } catch (err) {
      console.error(`[test-bot] cannot seal reply: ${(err as Error).message}`);
      return this.end(conversation, true);
    }
    talk.startedAt = performance.now();
    this.sendFrames();
  }

  // Real time: each frame when it's due, catching up after a late timer.
  private sendFrames(): void {
    const talk = this.speaking;
    if (!talk) return;
    const { conversation, frames, cipher } = talk;
    // Sealed at talk-start; nothing goes out in plaintext.
    if (!cipher) return;
    while (talk.next < frames.length) {
      const due = talk.startedAt + talk.next * this.opts.frameMs;
      if (this.opts.frameMs > 0 && due > performance.now()) {
        talk.timer = this.later(Math.max(1, due - performance.now()), () => {
          talk.timer = null;
          if (this.speaking === talk) this.sendFrames();
        });
        return;
      }
      const plain = withSeq(frames[talk.next], talk.next);
      this.relay.handleAudio(conversation.peer, cipher.seal(plain[0]!, talk.next, plain.subarray(FRAME_HEADER_BYTES)));
      talk.next++;
    }
    this.relay.handleMessage(conversation.peer, { type: "talk-end", burstId: talk.burstId });
    this.resetIdle(conversation);
    this.speaking = null;
    // After the relay's answers to this burst.
    setImmediate(() => this.speakNext());
  }

  private stopSpeaking(): void {
    const talk = this.speaking;
    if (!talk) return;
    if (talk.timer) {
      clearTimeout(talk.timer);
      this.timers.delete(talk.timer);
    }
    this.speaking = null;
    setImmediate(() => this.speakNext());
  }

  private resetIdle(conversation: BotConversation): void {
    if (conversation.idleTimer) {
      clearTimeout(conversation.idleTimer);
      this.timers.delete(conversation.idleTimer);
    }
    conversation.idleTimer = this.later(this.opts.idleMs, () => {
      // Still talking (a long echo) or hearing a long burst: not idle.
      if (this.speaking?.conversation === conversation || conversation.hearing) return this.resetIdle(conversation);
      this.end(conversation, true);
    });
  }

  // `leave`: the bot leaves the conversation itself; otherwise the relay already dropped it.
  private end(conversation: BotConversation, leave: boolean): void {
    if (this.conversations.get(conversation.id) !== conversation) return;
    this.conversations.delete(conversation.id);
    if (conversation.idleTimer) {
      clearTimeout(conversation.idleTimer);
      this.timers.delete(conversation.idleTimer);
    }
    if (this.speaking?.conversation === conversation) this.stopSpeaking();
    conversation.inbox.length = 0;
    if (leave) this.relay.handleMessage(conversation.peer, { type: "leave", conversationId: conversation.id });
    // Ends anything the bot was saying there, and leaves if it hadn't.
    this.relay.disconnect(conversation.peer);
  }
}

function makeFrame(codec: number, seq: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  out[0] = codec;
  out.writeUInt32BE(seq, 1);
  payload.copy(out, FRAME_HEADER_BYTES);
  return out;
}

// The same frame with its sequence number within the bot's burst.
function withSeq(original: Buffer, seq: number): Buffer {
  const out = Buffer.from(original);
  out.writeUInt32BE(seq, 1);
  return out;
}

// tools/opus-frames.swift's output: each packet as [length: UInt16 big-endian][packet].
export function parsePackets(packed: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset + 2 <= packed.length; ) {
    const length = packed.readUInt16BE(offset);
    if (offset + 2 + length > packed.length) throw new Error("truncated Opus packet");
    packets.push(packed.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return packets;
}

export function loadGreeting(path = GREETING_FILE): Buffer[] {
  return parsePackets(readFileSync(path));
}
