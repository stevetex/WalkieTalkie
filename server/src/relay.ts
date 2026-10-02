// Conversation relay: floor control, burst buffering, ring-to-start pushes and replay.
// Transport-agnostic so tests can drive it with fake peers.
//
// Rings (contracts/README.md, "Rings"): each has an ID, a deadline and a state. One device rings
// at a time (ringCandidates). An answer claims the ring for a device; a join names the ring it
// answers, so a late tap can't join a newer ring or hear audio that was dropped.

import { randomBytes, randomUUID } from "node:crypto";
import type { Pusher } from "./apns.ts";
import { encodeJSONRecord, encodeRecord, RecordType } from "./records.ts";
import type { MetricsStore } from "./store.ts";
import type { AccountDevice, RingLookup } from "./accounts.ts";
import { ApnsDelivery, Deliveries, type DeliveryOutcome, type PushDelivery } from "./delivery.ts";
import {
  DEFAULT_CAPABILITIES,
  codecName,
  deliveryToken,
  isNotificationDelivery,
  platformLabel,
  type CodecName,
  type ClientKind,
  type FormFactor,
} from "./contract.ts";
import { FRAME_MS, isValidFrame, type ClientMessage, type RelayErrorCode, type RingPayload, type ServerMessage } from "./protocol.ts";

export interface Peer {
  userId: string;
  // The device this connection comes from (the session token's device). A user can be
  // connected from several devices at once.
  deviceId: string;
  // Never rings anyone (the Test Bot, test-bot.ts): talking to someone who isn't in the
  // conversation is refused ("unavailable") instead.
  noRings?: boolean;
  // What the device said at admission, for diagnostics.
  clientKind?: ClientKind;
  // The codecs it plays; absent = both, as every Apple build does.
  decode?: CodecName[];
  sendJSON(message: ServerMessage): void;
  sendBinary(frame: Buffer): void;
}

// A rejoin's resume: the burst the member was hearing and the first frame (by its sequence
// number) they didn't get.
export interface Resume {
  burstId: string;
  fromSeq: number;
}

// The result of an answer, a decline or a prefetch for a named ring.
export type RingCallResult<T = RingPayload> = { ok: true; value: T } | { ok: false; error: RelayErrorCode };

// A voice frame's sequence number (protocol.ts: kind byte, then a 32-bit big-endian seq).
function frameSeq(frame: Buffer): number {
  return frame.length >= 5 ? frame.readUInt32BE(1) : 0;
}

interface Burst {
  id: string;
  from: string;
  // The codec of its frames, named at talk-start.
  codec: number;
  // Kept only until the other member hears them: frames forwarded live aren't kept, and a
  // replay empties this once it's sent.
  frames: Buffer[];
  bytes: number;
  // Every frame received, kept or not, against maxBurstMs.
  frameCount: number;
  ended: boolean;
  startedAt: number;
  // Members this burst has started playing for; later frames are forwarded live to them.
  deliveredTo: Set<string>;
  // Every frame sent to the other member (replayed or live), kept until resumeTtlMs after the
  // burst ends, so a member whose stream dropped mid-burst can rejoin and resume from the
  // first frame it missed (Relay.completeJoin, the join's resume).
  sent: Buffer[];
  endedAt: number | null;
  firstLiveFrameLogged: boolean;
  // Ends the burst at maxBurstMs if the sender never does.
  timer: NodeJS.Timeout | null;
}

// A conversation's latest ring. Kept after it's joined or ends, so a join or an answer can be
// checked against it; a new ring replaces it.
interface RingState {
  id: string;
  to: string;
  from: string;
  fromName: string;
  burstId: string;
  // ringing: no answer yet; answered: a device claimed it and has answerJoinTimeoutMs to join;
  // joined: the recipient joined; ended: it ran out, or couldn't ring anyone.
  state: "ringing" | "answered" | "joined" | "ended";
}

interface Conversation {
  id: string;
  members: [string, string];
  // Who's in the conversation, and from which of their devices.
  joined: Map<string, string>;
  // The device each member last joined or talked from. A ring later in the conversation goes
  // there first, so the device in use keeps the conversation (design decision 2026-09-27).
  lastDevice: Map<string, string>;
  bursts: Burst[];
  floor: { userId: string; burstId: string } | null;
  ring: RingState | null;
  lastRingAt: number | null;
  // When the current ring is abandoned. A rollover to the iPhone keeps the first ring's time.
  ringExpiresAt: number | null;
  // Set while a ring is waiting to be answered (or, once answered, to be joined).
  ringTimer: NodeJS.Timeout | null;
  // Set while a ring to the watch waits to roll over to the iPhone (rollOverMs).
  rollOverTimer: NodeJS.Timeout | null;
  // The ring rolled over to the iPhone.
  rolledOver: boolean;
  // The recipient's latest answer (POST /v2/rings/answer), and from which device: the claim on
  // the ring.
  answer: { userId: string; deviceId: string | undefined; at: number } | null;
  // When each member's talking was last recorded as "last messaged you" (recordMessage).
  messageRecordedAt: Map<string, number>;
  // Accounts: when the two were last confirmed as friends (the ring's lookup, or canTalk), and
  // the check in flight, if any. See authorize.
  authorizedAt: number | null;
  authorizing: Promise<boolean> | null;
  // Prototype: the second, prefetch push for the current APNs ring (see prefetchAlert).
  prefetch: {
    to: string;
    target: AccountDevice;
    timer: NodeJS.Timeout | null;
  } | null;
}

type RingResult = { pushed: boolean } | { refused: "not-friends" | "unavailable" | "unsupported-codec" };

export interface RelayOptions {
  // The friend check and the account's devices, once per ring.
  accounts: {
    ringLookup(from: string, to: string): Promise<RingLookup>;
    // Whether two accounts may still talk, checked again while they do (see authorize).
    // Without it, ringLookup's answer is used.
    canTalk?(from: string, to: string): Promise<boolean>;
    // A device a provider said can't be reached (an unregistered token): its registration goes,
    // unless the device has registered a new token since.
    removeDevice?(userId: string, deviceId: string, pushToken: string): Promise<boolean>;
    // "Last messaged you" on the recipient's friend page; off the audio path.
    recordMessage?(from: string, to: string, at: number): Promise<void>;
    // The person used this device (talked or joined): it orders their devices for rings.
    markActive?(userId: string, deviceId: string, at: number): Promise<void>;
  };
  // APNs. Ring deliveries go through `deliveries` if given (which may add the FCM stub), else
  // through this.
  pusher: Pusher;
  deliveries?: Deliveries;
  metrics: MetricsStore;
  now?: () => number;
  // Backstop for audio that was never rung (for example, no registered device).
  bufferTtlMs?: number;
  // An unanswered ring is abandoned after this long and its unheard audio dropped.
  // Slightly longer than the watch's 30 s ring, so a late push that's still answered
  // in time doesn't lose the message. (Design decision: unheard messages are dropped
  // rather than kept as clips; see the feasibility doc's "Design decisions".)
  ringTimeoutMs?: number;
  // How long a heard burst's frames are kept after it ends, for a member who rejoins after
  // their stream dropped (run 106: the iPhone lost the network mid-message).
  resumeTtlMs?: number;
  // After the watch reports it answered, how long it has to open the relay socket and
  // join before the ring is abandoned. Socket setup on a real watch took ~7 s.
  answerJoinTimeoutMs?: number;
  // When the recipient chose to (rollOver), a ring to their watch that isn't answered or
  // declined in this long rings their iPhone, within the same ringTimeoutMs.
  rollOverMs?: number;
  // Prototype: after an APNs ring, send a prefetch push once the sender's first burst ends,
  // or this long after the ring if they're still talking. 0 = no prefetch pushes.
  prefetchPushAfterMs?: number;
  // Accounts: how long a friendship check holds before a talk, join or live audio checks
  // again, so a block, an unfriending or a deleted account ends a conversation under way.
  authTtlMs?: number;
  // A burst ends by itself after this long, whether or not the sender says so.
  maxBurstMs?: number;
  // Audio a conversation holds for a member who hasn't heard it yet. A burst that would go
  // past this ends.
  maxBufferedBytes?: number;
}

export class Relay {
  // User → device → connection.
  private peers = new Map<string, Map<string, Peer>>();
  private byPair = new Map<string, Conversation>();
  private byId = new Map<string, Conversation>();
  private activeBursts = new Map<string, { conversation: Conversation; burst: Burst; deviceId: string }>();
  private deliveries: Deliveries;
  private opts: Required<Omit<RelayOptions, "deliveries">>;

  constructor(options: RelayOptions) {
    this.opts = {
      now: Date.now,
      bufferTtlMs: 120_000,
      resumeTtlMs: 30_000,
      ringTimeoutMs: 35_000,
      answerJoinTimeoutMs: 30_000,
      rollOverMs: 12_000,
      prefetchPushAfterMs: 0,
      authTtlMs: 10_000,
      maxBurstMs: 60_000,
      // About two minutes of PCM, or twenty of Opus.
      maxBufferedBytes: 4 * 1024 * 1024,
      ...options,
    };
    this.deliveries = options.deliveries ?? new Deliveries({ apns: new ApnsDelivery(options.pusher) });
  }

  close(): void {
    for (const conversation of this.byId.values()) this.clearRing(conversation);
  }

  connect(peer: Peer): void {
    const previous = this.devicePeer(peer.userId, peer.deviceId);
    if (previous && previous !== peer) this.disconnect(previous);
    let devices = this.peers.get(peer.userId);
    if (!devices) this.peers.set(peer.userId, (devices = new Map()));
    devices.set(peer.deviceId, peer);
  }

  disconnect(peer: Peer): void {
    const devices = this.peers.get(peer.userId);
    if (devices?.get(peer.deviceId) !== peer) return;
    devices.delete(peer.deviceId);
    if (!devices.size) this.peers.delete(peer.userId);
    if (this.activeBursts.get(peer.userId)?.deviceId === peer.deviceId) this.endActiveBurst(peer.userId);
    for (const conversation of [...this.byId.values()]) {
      if (conversation.joined.get(peer.userId) === peer.deviceId) this.leave(peer.userId, conversation);
    }
  }

  private devicePeer(userId: string, deviceId: string): Peer | undefined {
    return this.peers.get(userId)?.get(deviceId);
  }

  // The connection of the device a member is in the conversation from.
  private memberPeer(conversation: Conversation, userId: string): Peer | undefined {
    const deviceId = conversation.joined.get(userId);
    return deviceId === undefined ? undefined : this.devicePeer(userId, deviceId);
  }

  // A member joins or talks from this device. If they were in the conversation from another
  // of their devices, it moves here, and that device is told.
  private enter(conversation: Conversation, peer: Peer): void {
    const previous = conversation.joined.get(peer.userId);
    if (previous !== undefined && previous !== peer.deviceId) {
      const active = this.activeBursts.get(peer.userId);
      if (active?.conversation === conversation && active.deviceId === previous) this.endActiveBurst(peer.userId);
      this.devicePeer(peer.userId, previous)?.sendJSON({ type: "moved", conversationId: conversation.id });
      this.opts.metrics.server(conversation.id, "movedDevice", this.opts.now(), peer.userId);
    }
    conversation.joined.set(peer.userId, peer.deviceId);
    conversation.lastDevice.set(peer.userId, peer.deviceId);
    this.markActive(peer.userId, peer.deviceId);
  }

  private markActive(userId: string, deviceId: string): void {
    this.opts.accounts.markActive?.(userId, deviceId, this.opts.now()).catch((err: Error) => {
      console.error(`[relay] recording ${userId}'s use of ${deviceId} failed: ${err.message}`);
    });
  }

  // An error for this connection, with its stable code.
  private error(peer: Peer, message: string, code: RelayErrorCode): void {
    peer.sendJSON({ type: "error", code, message });
  }

  handleMessage(peer: Peer, message: ClientMessage): void {
    switch (message.type) {
      case "hello":
        peer.sendJSON({ type: "hello-ack", clientTime: message.clientTime, serverTime: this.opts.now() });
        break;
      case "talk-start":
        this.talkStart(peer, message.to, message.burstId, message.codec);
        break;
      case "talk-end":
        this.talkEnd(peer.userId, message.burstId);
        break;
      case "join":
        this.join(peer, message.conversationId, message.ringId, message.resume);
        break;
      case "leave": {
        const conversation = this.byId.get(message.conversationId);
        if (conversation?.joined.get(peer.userId) === peer.deviceId) this.leave(peer.userId, conversation);
        break;
      }
      default:
        this.error(peer, "unknown message type", "unknown-message");
    }
  }

  handleAudio(peer: Peer, frame: Buffer): void {
    const active = this.activeBursts.get(peer.userId);
    if (!active || active.deviceId !== peer.deviceId) return;
    // Only frames the apps can decode are passed on.
    if (!isValidFrame(frame)) return;
    const { conversation, burst } = active;
    // A burst is one codec: the one named at talk-start.
    if (frame[0] !== burst.codec) return;
    burst.frameCount++;
    // Faster than real time: the timer alone wouldn't stop it in time.
    if (burst.frameCount > this.opts.maxBurstMs / FRAME_MS) return this.cutOff(peer.userId, "burst too long", "burst-too-long");
    const other = otherMember(conversation, peer.userId);
    if (burst.deliveredTo.has(other)) {
      // Heard live, so there's nothing to keep for a replay; kept only to resume a member
      // whose stream drops (sent to a dead stream, or to nobody until they rejoin).
      burst.sent.push(frame);
      this.memberPeer(conversation, other)?.sendBinary(frame);
      if (!burst.firstLiveFrameLogged) {
        burst.firstLiveFrameLogged = true;
        this.opts.metrics.server(conversation.id, "firstFrameForwardedLive", this.opts.now());
      }
      if (!this.recentlyAuthorized(conversation)) {
        void this.authorize(conversation, peer.userId, other).then((allowed) => {
          if (!allowed) this.revoke(conversation);
        });
      }
      return;
    }
    if (bufferedBytes(conversation) + frame.length > this.opts.maxBufferedBytes) return this.cutOff(peer.userId, "too much audio waiting", "too-much-audio");
    burst.frames.push(frame);
    burst.bytes += frame.length;
  }

  // Ends a sender's burst that went past a limit, and says why.
  private cutOff(userId: string, why: string, code: RelayErrorCode): void {
    const active = this.activeBursts.get(userId);
    if (!active) return;
    this.opts.metrics.server(active.conversation.id, "burstCutOff", this.opts.now(), why);
    const peer = this.devicePeer(userId, active.deviceId);
    if (peer) this.error(peer, why, code);
    this.endActiveBurst(userId);
  }

  // The recipient answered (reported over HTTPS, which works before a socket can open): this
  // device claims the ring, and has answerJoinTimeoutMs to connect and join. A claim stops the
  // rollover; a second device's claim is refused while the first's grace lasts; once someone
  // has joined, another device's answer is a move, which its join makes.
  answer(userId: string, deviceId: string, conversationId: string, ringId: string): RingCallResult {
    const conversation = this.byId.get(conversationId);
    if (!conversation) return { ok: false, error: "ring-expired" };
    if (!conversation.members.includes(userId)) return { ok: false, error: "unknown-conversation" };
    const problem = this.ringProblem(conversation, userId, ringId, deviceId);
    this.opts.metrics.server(conversation.id, "answerReported", this.opts.now(), problem ?? ringId);
    if (problem) return { ok: false, error: problem };
    if (conversation.ring!.state === "ringing") this.claim(conversation, userId, deviceId);
    return { ok: true, value: this.envelope(conversation) };
  }

  private claim(conversation: Conversation, userId: string, deviceId: string): void {
    this.clearRollOver(conversation);
    conversation.answer = { userId, deviceId, at: this.opts.now() };
    if (conversation.ring) conversation.ring.state = "answered";
    this.armRingTimer(conversation, userId, this.opts.answerJoinTimeoutMs);
  }

  // Why this device can't answer or join this ring now, or null if it can.
  private ringProblem(conversation: Conversation, userId: string, ringId: string, deviceId: string | undefined): RelayErrorCode | null {
    const ring = conversation.ring;
    if (!ring || ring.id !== ringId || ring.to !== userId || ring.state === "ended") return "ring-expired";
    const now = this.opts.now();
    if (ring.state === "ringing" && conversation.ringExpiresAt !== null && now >= conversation.ringExpiresAt) return "ring-expired";
    if (ring.state === "answered") {
      const answer = conversation.answer;
      if (answer && now - answer.at > this.opts.answerJoinTimeoutMs) return "ring-expired";
      if (answer && answer.deviceId !== undefined && deviceId !== undefined && answer.deviceId !== deviceId) return "ring-answered-elsewhere";
    }
    return null;
  }

  // The recipient's Decline: the ring doesn't roll over to the iPhone. Otherwise it runs out as
  // before. Repeating it is harmless.
  decline(userId: string, conversationId: string, ringId: string): RingCallResult<null> {
    const conversation = this.byId.get(conversationId);
    if (!conversation) return { ok: false, error: "ring-expired" };
    if (!conversation.members.includes(userId)) return { ok: false, error: "unknown-conversation" };
    const ring = conversation.ring;
    if (!ring || ring.id !== ringId || ring.to !== userId || ring.state === "ended") return { ok: false, error: "ring-expired" };
    this.opts.metrics.server(conversation.id, "declineReported", this.opts.now());
    this.clearRollOver(conversation);
    return { ok: true, value: null };
  }

  // Rings waiting for this account's answer, newest first (GET /v2/rings/pending), for an app
  // opened without a notification to say which.
  pendingRings(userId: string): RingPayload[] {
    const now = this.opts.now();
    return [...this.byId.values()]
      .filter((c) => c.ring?.to === userId && c.ring.state === "ringing" && c.ringExpiresAt !== null && now < c.ringExpiresAt)
      .map((c) => this.envelope(c))
      .sort((a, b) => b.pushSentAt - a.pushSentAt);
  }

  // A rolled-over (or otherwise claimed) ring that another device answered just as this one
  // joined: this device's join gives way to the device that claimed it, which is still
  // connecting, so the message plays only there. This device hears "moved", as when a
  // conversation moves.
  private answeredElsewhere(peer: Peer, conversation: Conversation): boolean {
    const answer = conversation.answer;
    if (!answer || answer.userId !== peer.userId) return false;
    if (answer.deviceId === peer.deviceId || conversation.joined.has(peer.userId)) return false;
    if (this.opts.now() - answer.at > this.opts.answerJoinTimeoutMs) return false;
    peer.sendJSON({ type: "moved", conversationId: conversation.id });
    this.opts.metrics.server(conversation.id, "joinGaveWay", this.opts.now(), "answered on another device");
    return true;
  }

  // Exposed for tests and the status endpoint.
  snapshot(): Array<{ id: string; members: string[]; joined: string[]; bufferedBursts: number; bufferedBytes: number; floor: string | null }> {
    return [...this.byId.values()].map((c) => ({
      id: c.id,
      members: [...c.members],
      joined: [...c.joined.keys()],
      bufferedBursts: c.bursts.length,
      bufferedBytes: bufferedBytes(c),
      floor: c.floor?.userId ?? null,
    }));
  }

  // Whether this connection can play a codec.
  private plays(peer: Peer, codec: number): boolean {
    const name = codecName(codec);
    return name !== undefined && (peer.decode ?? DEFAULT_CAPABILITIES.decode).includes(name);
  }

  private talkStart(peer: Peer, to: string, burstId: string, codec: number): void {
    const from = peer.userId;
    const now = this.opts.now();
    if (to === from) {
      this.error(peer, "cannot talk to yourself", "unknown-conversation");
      return;
    }
    const conversation = this.conversationFor(from, to);
    this.pruneBursts(conversation);

    const holder = conversation.floor;
    if (holder && holder.userId !== from) {
      peer.sendJSON({ type: "floor-denied", burstId, holder: holder.userId });
      return;
    }
    this.endActiveBurst(from);

    this.enter(conversation, peer);
    this.recordMessage(conversation, from, to, now);
    const burst: Burst = {
      id: burstId,
      from,
      codec,
      frames: [],
      bytes: 0,
      frameCount: 0,
      ended: false,
      startedAt: now,
      deliveredTo: new Set(),
      sent: [],
      endedAt: null,
      firstLiveFrameLogged: false,
      timer: null,
    };
    conversation.bursts.push(burst);
    conversation.floor = { userId: from, burstId };
    this.activeBursts.set(from, { conversation, burst, deviceId: peer.deviceId });
    burst.timer = setTimeout(() => {
      if (this.activeBursts.get(from)?.burst === burst) this.cutOff(from, "burst too long", "burst-too-long");
    }, this.opts.maxBurstMs);
    burst.timer.unref();
    this.opts.metrics.server(conversation.id, "talkStart", now, `${from} -> ${to}`);

    const deliver = (): void => {
      const listener = this.memberPeer(conversation, to);
      if (listener) {
        // Codec admission: never forward a codec the listener can't play.
        if (!this.plays(listener, burst.codec)) return this.refuse(peer, conversation, burstId, "unsupported-codec");
        this.startDelivery(conversation, burst, to, false);
        this.grantFloor(peer, conversation, burstId, false);
      } else if (peer.noRings) {
        // The Test Bot's caller left just as it started talking.
        this.refuse(peer, conversation, burstId, "unavailable");
      } else if (!conversation.ringTimer) {
        // One ring per conversation start; further bursts queue behind the pending ring.
        // The ring looks the devices up in the store, so only a Talk that rings waits for
        // the store. Frames that arrive meanwhile are buffered in the burst as usual.
        void this.ring(conversation, from, to, burstId, burst.codec).then((result) => {
          if ("refused" in result) this.refuse(peer, conversation, burstId, result.refused);
          else this.grantFloor(peer, conversation, burstId, result.pushed);
        });
      } else {
        this.grantFloor(peer, conversation, burstId, false);
      }
    };
    // Talking to someone already listening: check they're still friends first, unless that was
    // just checked (a ring checks for itself). Frames buffer in the burst meanwhile.
    if (this.recentlyAuthorized(conversation) || !this.memberPeer(conversation, to)) return deliver();
    void this.authorize(conversation, from, to).then((allowed) => {
      if (this.byId.get(conversation.id) !== conversation || !conversation.bursts.includes(burst)) return;
      if (allowed) deliver();
      else this.revoke(conversation);
    });
  }

  // At most once a minute per sender and conversation, and never waited for.
  private recordMessage(conversation: Conversation, from: string, to: string, now: number): void {
    const last = conversation.messageRecordedAt.get(from);
    if (last !== undefined && now - last < 60_000) return;
    const record = this.opts.accounts.recordMessage;
    if (!record) return;
    conversation.messageRecordedAt.set(from, now);
    record.call(this.opts.accounts, from, to, now).catch((err: Error) => {
      console.error(`[relay] recording a message from ${from} to ${to} failed: ${err.message}`);
    });
  }

  private grantFloor(peer: Peer, conversation: Conversation, burstId: string, pushed: boolean): void {
    peer.sendJSON({ type: "floor-granted", burstId, conversationId: conversation.id, pushed });
    this.opts.metrics.server(conversation.id, "floorGrantSent", this.opts.now(), peer.userId);
  }

  // Not friends, none of their devices can be rung, or they can't play the codec: drop
  // everything the sender has queued in this conversation, unring, and say why. Frames still
  // arriving for the burst are ignored.
  private refuse(peer: Peer, conversation: Conversation, burstId: string, reason: "not-friends" | "unavailable" | "unsupported-codec"): void {
    const from = peer.userId;
    if (this.activeBursts.get(from)?.conversation === conversation) this.dropActiveBurst(from);
    conversation.bursts = conversation.bursts.filter((b) => b.from !== from);
    if (conversation.floor?.userId === from) conversation.floor = null;
    conversation.joined.delete(from);
    if (reason === "unsupported-codec") this.opts.metrics.server(conversation.id, "codecRefused", this.opts.now());
    peer.sendJSON({ type: "talk-refused", burstId, reason });
    this.prune(conversation);
  }

  private talkEnd(userId: string, burstId: string): void {
    const active = this.activeBursts.get(userId);
    if (!active || active.burst.id !== burstId) return;
    this.endActiveBurst(userId);
  }

  // Forgets a sender's burst in progress without ending it for the listener.
  private dropActiveBurst(userId: string): void {
    const active = this.activeBursts.get(userId);
    if (!active) return;
    this.activeBursts.delete(userId);
    if (active.burst.timer) clearTimeout(active.burst.timer);
    active.burst.timer = null;
  }

  private endActiveBurst(userId: string): void {
    const active = this.activeBursts.get(userId);
    if (!active) return;
    this.dropActiveBurst(userId);
    const { conversation, burst } = active;
    burst.ended = true;
    burst.endedAt = this.opts.now();
    if (conversation.floor?.burstId === burst.id) conversation.floor = null;
    for (const member of burst.deliveredTo) {
      this.memberPeer(conversation, member)?.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
    }
    if (conversation.prefetch && burst.from !== conversation.prefetch.to) this.sendPrefetchPush(conversation);
    // For usage analytics (telemetry.ts): who talked and for how long.
    this.opts.metrics.server(conversation.id, "burstEnded", this.opts.now(), `${burst.from} ${Math.round(this.opts.now() - burst.startedAt)} ms, ${burst.frameCount} frames`);
    this.prune(conversation);
  }

  // The buffered message a ring's recipient hasn't heard yet, as stream records (burst-start,
  // frames, burst-end if it has ended), for the watch's notification service extension to
  // download before the tap. Read-only: the join still replays it, and the app skips the
  // frames it already played. Only while that ring is current.
  bufferedAudio(userId: string, conversationId: string, ringId: string): RingCallResult<{ records: Buffer; bursts: number; frames: number; ring: RingPayload | null }> {
    const conversation = this.byId.get(conversationId);
    if (!conversation) return { ok: false, error: "ring-expired" };
    if (!conversation.members.includes(userId)) return { ok: false, error: "unknown-conversation" };
    const ring = conversation.ring;
    if (!ring || ring.id !== ringId || ring.to !== userId || ring.state === "ended") return { ok: false, error: "ring-expired" };
    const parts: Buffer[] = [];
    let bursts = 0;
    let frames = 0;
    for (const burst of conversation.bursts) {
      if (burst.from === userId || burst.deliveredTo.has(userId)) continue;
      bursts++;
      frames += burst.frames.length;
      parts.push(encodeJSONRecord({ type: "burst-start", conversationId, burstId: burst.id, from: burst.from, replay: true }));
      for (const frame of burst.frames) parts.push(encodeRecord(RecordType.audio, frame));
      if (burst.ended) parts.push(encodeJSONRecord({ type: "burst-end", conversationId, burstId: burst.id }));
    }
    this.opts.metrics.server(conversationId, "audioPrefetched", this.opts.now(), `${bursts} bursts, ${frames} frames`);
    return { ok: true, value: { records: Buffer.concat(parts), bursts, frames, ring: conversation.ring ? this.envelope(conversation) : null } };
  }

  // A join names the ring it answers; without one, only a member rejoining or moving may join.
  private join(peer: Peer, conversationId: string, ringId: string | undefined, resume?: Resume): void {
    const conversation = this.byId.get(conversationId);
    if (!conversation || !conversation.members.includes(peer.userId)) {
      return this.error(peer, "unknown conversation", ringId !== undefined && !conversation ? "ring-expired" : "unknown-conversation");
    }
    const problem = ringId !== undefined
      ? this.ringProblem(conversation, peer.userId, ringId, undefined)
      : conversation.lastDevice.has(peer.userId) ? null : "ring-expired";
    if (problem) {
      this.opts.metrics.server(conversation.id, "joinRefused", this.opts.now(), problem);
      return this.error(peer, problem === "ring-expired" ? "this ring has ended" : "answered on another device", problem);
    }
    // Replay only to a friend: check again unless that was just checked (by the ring, usually).
    if (this.recentlyAuthorized(conversation)) return this.completeJoin(peer, conversation, resume);
    void this.authorize(conversation, peer.userId, otherMember(conversation, peer.userId)).then((allowed) => {
      // Disconnected meanwhile.
      if (this.devicePeer(peer.userId, peer.deviceId) !== peer) return;
      if (!allowed) this.revoke(conversation);
      if (!allowed || this.byId.get(conversation.id) !== conversation) {
        return this.error(peer, "unknown conversation", "unknown-conversation");
      }
      this.completeJoin(peer, conversation, resume);
    });
  }

  private completeJoin(peer: Peer, conversation: Conversation, resume?: Resume): void {
    if (this.answeredElsewhere(peer, conversation)) return;
    const conversationId = conversation.id;
    const now = this.opts.now();
    this.pruneBursts(conversation);
    this.enter(conversation, peer);
    if (conversation.ring?.to === peer.userId && conversation.ring.state !== "ended") conversation.ring.state = "joined";
    this.clearRing(conversation);
    // A rejoin after the stream dropped: the burst they were hearing, from the first frame
    // they didn't get. Then anything they haven't heard at all, as on a first join.
    const resumed = resume
      ? conversation.bursts.find((b) => b.id === resume.burstId && b.from !== peer.userId && b.deliveredTo.has(peer.userId))
      : undefined;
    const pending = conversation.bursts.filter((b) => b.from !== peer.userId && !b.deliveredTo.has(peer.userId));
    const other = otherMember(conversation, peer.userId);
    const missed = resumed && resume ? resumed.sent.filter((f) => frameSeq(f) >= resume.fromSeq) : [];
    const ringId = conversation.ring ? { ringId: conversation.ring.id } : {};
    peer.sendJSON({ type: "joined", conversationId, peer: other, replayBursts: pending.length + (resumed ? 1 : 0), ...(resumed ? { resumedFrames: missed.length } : {}), ...ringId });
    this.opts.metrics.server(conversation.id, "receiverJoined", now, `${pending.length} buffered${resume ? `, resumed ${missed.length} frames` : ""}`);
    if (resumed) {
      peer.sendJSON({ type: "burst-start", conversationId, burstId: resumed.id, from: resumed.from, replay: true, resumed: true, ...this.codecField(resumed) });
      for (const frame of missed) peer.sendBinary(frame);
      if (resumed.ended) peer.sendJSON({ type: "burst-end", conversationId, burstId: resumed.id });
    }
    for (const burst of pending) this.startDelivery(conversation, burst, peer.userId, true);
  }

  private codecField(burst: Burst): { codec?: string } {
    const name = codecName(burst.codec);
    return name ? { codec: name } : {};
  }

  private leave(userId: string, conversation: Conversation): void {
    conversation.joined.delete(userId);
    if (conversation.floor?.userId === userId) this.endActiveBurst(userId);
    const other = otherMember(conversation, userId);
    this.memberPeer(conversation, other)?.sendJSON({ type: "peer-left", conversationId: conversation.id, peer: userId });
    this.prune(conversation);
  }

  private startDelivery(conversation: Conversation, burst: Burst, to: string, replay: boolean): void {
    const peer = this.memberPeer(conversation, to);
    if (!peer) return;
    burst.deliveredTo.add(to);
    // A held burst in a codec this device can't play (a join from a device that wasn't the one
    // rung) is skipped rather than sent to its decoder.
    if (!this.plays(peer, burst.codec)) {
      this.opts.metrics.server(conversation.id, "burstUndecodable", this.opts.now(), burst.id);
      burst.frames = [];
      burst.bytes = 0;
      return;
    }
    peer.sendJSON({ type: "burst-start", conversationId: conversation.id, burstId: burst.id, from: burst.from, replay, ...this.codecField(burst) });
    if (replay) {
      this.opts.metrics.server(conversation.id, "replayStarted", this.opts.now(), `${burst.frames.length} frames`);
    }
    for (const frame of burst.frames) peer.sendBinary(frame);
    burst.sent.push(...burst.frames);
    // Heard: nothing left to replay (the sender never gets their own bursts).
    burst.frames = [];
    burst.bytes = 0;
    if (burst.ended) peer.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
  }

  // The ring as every device gets it.
  private envelope(conversation: Conversation): RingPayload {
    const ring = conversation.ring;
    const pushSentAt = conversation.lastRingAt ?? this.opts.now();
    return {
      schemaVersion: 2,
      ringId: ring?.id ?? "",
      conversationId: conversation.id,
      from: ring?.from ?? "",
      fromName: ring?.fromName ?? "",
      burstId: ring?.burstId ?? "",
      pushSentAt,
      expiresAt: conversation.ringExpiresAt ?? pushSentAt + this.opts.ringTimeoutMs,
    };
  }

  private async ring(conversation: Conversation, from: string, to: string, burstId: string, codec: number): Promise<RingResult> {
    // Armed before the lookup, so a second Talk meanwhile doesn't ring again.
    conversation.ring = { id: newRingId(), to, from, fromName: from, burstId, state: "ringing" };
    conversation.rolledOver = false;
    conversation.answer = null;
    conversation.ringExpiresAt = null;
    this.armRingTimer(conversation, to, this.opts.ringTimeoutMs);
    const ring = conversation.ring;
    const ended = (): void => {
      ring.state = "ended";
      this.clearRing(conversation);
    };
    let lookup: RingLookup;
    try {
      lookup = await this.opts.accounts.ringLookup(from, to);
    } catch (err) {
      ended();
      this.opts.metrics.server(conversation.id, "pushFailed", this.opts.now(), `device lookup: ${(err as Error).message}`);
      console.error(`[relay] device lookup for ${to} failed: ${(err as Error).message}`);
      return { pushed: false };
    }
    if (!lookup.allowed) {
      ended();
      this.opts.metrics.server(conversation.id, "ringRefused", this.opts.now(), "not friends");
      return { refused: "not-friends" };
    }
    conversation.authorizedAt = this.opts.now();
    ring.fromName = lookup.fromName;
    // One device rings (contracts/README.md, "Choosing the device that rings"). If its
    // provider turns it away for good (an unregistered token), its registration goes and the
    // next one rings instead.
    const candidates = this.ringCandidates(conversation, to, lookup.devices, lookup.preferredFormFactor, codec);
    for (const target of candidates) {
      // Answered, or the relay is shutting down, meanwhile.
      if (!conversation.ringTimer) return { pushed: false };
      const outcome = await this.ringDevice(conversation, to, target);
      if (outcome === "permanentlyRejected") {
        this.removeRejected(to, [target]);
        continue;
      }
      const pushed = outcome !== "unreachable";
      if (pushed && lookup.rollOver && target.formFactor === "watch") {
        this.armRollOver(conversation, to, lookup.devices, codec);
      }
      return { pushed };
    }
    ended();
    const anyIgnoringCodec = candidates.length === 0 && this.ringCandidates(conversation, to, lookup.devices, lookup.preferredFormFactor, null).length > 0;
    this.opts.metrics.server(conversation.id, "pushSkipped", this.opts.now(), anyIgnoringCodec ? `no device for ${to} plays the codec` : `no device for ${to}`);
    // The caller learns at once that nobody will hear it.
    return { refused: anyIgnoringCodec ? "unsupported-codec" : "unavailable" };
  }

  private removeRejected(to: string, rejected: AccountDevice[]): void {
    for (const device of rejected) {
      const token = deliveryToken(device.delivery);
      if (!token) continue;
      this.opts.accounts.removeDevice?.(to, device.id, token).then(
        (removed) => removed && console.log(`[relay] removed ${to}'s unregistered ${device.clientKind} (${device.id})`),
        (err: Error) => console.error(`[relay] removing ${to}'s device ${device.id} failed: ${err.message}`),
      );
    }
  }

  // Ring Me On's rollover (design decision 2026-10-01): the recipient chose to have their
  // phone rung when they don't answer or decline on the watch in rollOverMs.
  private armRollOver(conversation: Conversation, to: string, devices: AccountDevice[], codec: number): void {
    this.clearRollOver(conversation);
    // Counted from the watch's ring, not from the provider's answer to it.
    const ms = Math.max(0, this.opts.rollOverMs - (this.opts.now() - (conversation.lastRingAt ?? this.opts.now())));
    conversation.rollOverTimer = setTimeout(() => void this.rollOver(conversation, to, devices, codec), ms);
    conversation.rollOverTimer.unref();
  }

  private clearRollOver(conversation: Conversation): void {
    if (conversation.rollOverTimer) clearTimeout(conversation.rollOverTimer);
    conversation.rollOverTimer = null;
  }

  // The watch wasn't answered: ring the phone, until the first ring would have run out. The
  // watch's ring stays on its screen; answering it later moves the conversation there.
  private async rollOver(conversation: Conversation, to: string, devices: AccountDevice[], codec: number): Promise<void> {
    conversation.rollOverTimer = null;
    if (!conversation.ringTimer || conversation.joined.has(to) || this.byId.get(conversation.id) !== conversation) return;
    const phones = this.ringCandidates(conversation, to, devices, "phone", codec).filter((d) => d.formFactor === "phone");
    if (!phones.length) {
      this.opts.metrics.server(conversation.id, "rollOverSkipped", this.opts.now(), "no phone to ring");
      return;
    }
    this.opts.metrics.server(conversation.id, "ringRolledOver", this.opts.now());
    conversation.rolledOver = true;
    // The watch's prefetch push is for a ring that's moved on.
    this.clearPrefetch(conversation);
    for (const phone of phones) {
      if (!conversation.ringTimer) return;
      const outcome = await this.ringDevice(conversation, to, phone, conversation.ringExpiresAt ?? undefined);
      if (outcome !== "permanentlyRejected") return;
      this.removeRejected(to, [phone]);
    }
  }

  // Rings one device and waits for its provider's answer. Over a relay connection, "unreachable"
  // if there was none to ring over.
  private async ringDevice(conversation: Conversation, to: string, target: AccountDevice, expiresAt?: number): Promise<DeliveryOutcome | "unreachable"> {
    conversation.lastRingAt = this.opts.now();
    conversation.ringExpiresAt = expiresAt ?? conversation.lastRingAt + this.opts.ringTimeoutMs;
    this.armRingTimer(conversation, to, Math.max(0, conversation.ringExpiresAt - conversation.lastRingAt));
    const payload = this.envelope(conversation);
    const delivery = target.delivery;
    // "watch; r_…; watchos apns/alert": the first part as before, for dashboards (telemetry.ts).
    this.opts.metrics.server(conversation.id, "pushSent", conversation.lastRingAt, `${platformLabel(target.clientKind)}; ${payload.ringId}; ${target.clientKind} ${delivery.provider}/${delivery.mode}`);
    if (delivery.provider === "relay" || delivery.provider === "test") {
      // Over the device's open relay stream (an iPhone app on screen), or any of the account's
      // (a test bot's).
      const peer = this.devicePeer(to, target.id) ?? (delivery.provider === "test" ? this.anyPeer(to) : undefined);
      peer?.sendJSON({ type: "ring", ...payload });
      this.opts.metrics.server(conversation.id, peer ? "pushAccepted" : "pushFailed", this.opts.now(), delivery.provider === "test" ? "local ring" : "in-app ring");
      return peer ? "accepted" : "unreachable";
    }
    if (delivery.provider === "apns" && delivery.mode === "alert" && this.opts.prefetchPushAfterMs > 0) {
      this.clearPrefetch(conversation);
      const prefetch = { to, target, timer: null as NodeJS.Timeout | null };
      conversation.prefetch = prefetch;
      prefetch.timer = setTimeout(() => this.sendPrefetchPush(conversation), this.opts.prefetchPushAfterMs);
      prefetch.timer.unref();
    }
    const result = await this.deliveries.send(delivery, payload, "ring");
    this.opts.metrics.server(conversation.id, result.outcome === "accepted" ? "pushAccepted" : "pushFailed", this.opts.now(), result.detail);
    if (result.outcome !== "accepted") console.error(`[relay] push to ${to} failed: ${result.detail}`);
    if (result.outcome === "permanentlyRejected" && conversation.prefetch?.target.id === target.id) this.clearPrefetch(conversation);
    return result.outcome;
  }

  private anyPeer(userId: string): Peer | undefined {
    return this.peers.get(userId)?.values().next().value;
  }

  // The recipient's devices that may ring, best first (contracts/README.md): the device they
  // last used in this conversation; then their preferred form factor's devices (automatic: the
  // watch if one can ring), most recently used first, ties by device ID; then the other form
  // factor's. Only one rings at a time.
  private ringCandidates(conversation: Conversation, to: string, devices: AccountDevice[], preferred: FormFactor | undefined, codec: number | null): AccountDevice[] {
    // codec null: whatever the burst's codec (to tell "nobody plays it" from "nobody at all").
    const eligible = devices.filter((d) => this.canRing(to, d, codec));
    const ordered: AccountDevice[] = [];
    const sticky = eligible.find((d) => d.id === conversation.lastDevice.get(to));
    if (sticky) ordered.push(sticky);
    const first: FormFactor = preferred ?? (eligible.some((d) => d.formFactor === "watch") ? "watch" : "phone");
    for (const formFactor of [first, first === "watch" ? "phone" : "watch"] as const) {
      ordered.push(
        ...eligible
          .filter((d) => d !== sticky && d.formFactor === formFactor)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      );
    }
    return ordered;
  }

  // Eligible: switched on, with a current session, able to play the burst, and with a way to be
  // rung now. Not a claim that it's online.
  private canRing(userId: string, device: AccountDevice, codec: number | null): boolean {
    if (!device.availability.enabled || device.hasSession === false) return false;
    const name = codec === null ? undefined : codecName(codec);
    if (name && !device.capabilities.decode.includes(name)) return false;
    if (device.availability.notifications === "denied" && isNotificationDelivery(device.delivery)) return false;
    switch (device.delivery.provider) {
      case "apns": return device.delivery.token !== "";
      case "fcm": return this.deliveries.has("fcm");
      // In-app rings need the app on screen, which is when its stream is open.
      case "relay": return this.devicePeer(userId, device.id) !== undefined;
      case "test": return true;
    }
  }

  // Nobody answered: drop what they didn't hear and tell the sender, so the next Talk
  // starts a fresh ring instead of replaying stale audio.
  private ringTimedOut(conversation: Conversation, from: string, to: string): void {
    conversation.ringTimer = null;
    this.clearRollOver(conversation);
    if (conversation.joined.has(to)) return;
    if (conversation.ring && conversation.ring.state !== "joined") conversation.ring.state = "ended";
    const unheard = conversation.bursts.filter((b) => b.from !== to && !b.deliveredTo.has(to));
    conversation.bursts = conversation.bursts.filter((b) => !unheard.includes(b));
    const frames = unheard.reduce((n, b) => n + b.frames.length, 0);
    this.opts.metrics.server(conversation.id, "ringTimedOut", this.opts.now(), `dropped ${unheard.length} bursts (${frames} frames)`);
    this.memberPeer(conversation, from)?.sendJSON({
      type: "ring-timeout",
      conversationId: conversation.id,
      peer: to,
      droppedBursts: unheard.length,
    });
    this.prune(conversation);
  }

  private recentlyAuthorized(conversation: Conversation): boolean {
    return conversation.authorizedAt !== null && this.opts.now() - conversation.authorizedAt < this.opts.authTtlMs;
  }

  // Accounts: whether the two may still talk (friends, neither account deleted). One check at
  // a time per conversation. A check that fails counts as allowed until the next one: an
  // outage isn't a block.
  private authorize(conversation: Conversation, from: string, to: string): Promise<boolean> {
    if (!conversation.authorizing) {
      const accounts = this.opts.accounts;
      const check = accounts.canTalk ? accounts.canTalk(from, to) : accounts.ringLookup(from, to).then((l) => l.allowed);
      conversation.authorizing = check
        .then(
          (allowed) => allowed,
          (err: Error) => {
            console.error(`[relay] checking ${from} and ${to} are friends failed: ${err.message}`);
            return true;
          },
        )
        .then((allowed) => {
          conversation.authorizing = null;
          if (allowed) conversation.authorizedAt = this.opts.now();
          return allowed;
        });
    }
    return conversation.authorizing;
  }

  // They may no longer talk (a block, an unfriending, a deleted account): drop the
  // conversation and all its audio, and tell whoever is in it.
  private revoke(conversation: Conversation): void {
    if (this.byId.get(conversation.id) !== conversation) return;
    this.opts.metrics.server(conversation.id, "conversationRevoked", this.opts.now(), "not friends");
    for (const member of conversation.members) {
      const active = this.activeBursts.get(member);
      if (active?.conversation === conversation) {
        this.dropActiveBurst(member);
        this.devicePeer(member, active.deviceId)?.sendJSON({ type: "talk-refused", burstId: active.burst.id, reason: "not-friends" });
      } else {
        this.memberPeer(conversation, member)?.sendJSON({ type: "conversation-ended", conversationId: conversation.id, reason: "not-friends" });
      }
    }
    this.clearRing(conversation);
    if (conversation.ring) conversation.ring.state = "ended";
    conversation.bursts = [];
    conversation.joined.clear();
    conversation.floor = null;
    this.byId.delete(conversation.id);
    this.byPair.delete(pairKey(...conversation.members));
    this.opts.metrics.server(conversation.id, "conversationEnded", this.opts.now(), "revoked");
  }

  private armRingTimer(conversation: Conversation, to: string, ms: number): void {
    if (conversation.ringTimer) clearTimeout(conversation.ringTimer);
    const from = conversation.ring?.from ?? otherMember(conversation, to);
    conversation.ringTimer = setTimeout(() => this.ringTimedOut(conversation, from, to), ms);
    conversation.ringTimer.unref();
  }

  private clearRing(conversation: Conversation): void {
    if (conversation.ringTimer) clearTimeout(conversation.ringTimer);
    conversation.ringTimer = null;
    this.clearRollOver(conversation);
    conversation.rolledOver = false;
    conversation.answer = null;
    this.clearPrefetch(conversation);
  }

  private clearPrefetch(conversation: Conversation): void {
    if (conversation.prefetch?.timer) clearTimeout(conversation.prefetch.timer);
    conversation.prefetch = null;
  }

  // Once per ring: the recipient hasn't joined, so the watch should fetch what's buffered.
  private sendPrefetchPush(conversation: Conversation): void {
    const prefetch = conversation.prefetch;
    if (!prefetch) return;
    this.clearPrefetch(conversation);
    if (conversation.joined.has(prefetch.to) || !conversation.ringTimer || conversation.ringExpiresAt === null) return;
    this.opts.metrics.server(conversation.id, "prefetchPushSent", this.opts.now());
    void this.deliveries.send(prefetch.target.delivery, this.envelope(conversation), "prefetch").then((result) => {
      this.opts.metrics.server(conversation.id, result.outcome === "accepted" ? "prefetchPushAccepted" : "prefetchPushFailed", this.opts.now(), result.detail);
    });
  }

  private conversationFor(a: string, b: string): Conversation {
    const key = pairKey(a, b);
    let conversation = this.byPair.get(key);
    if (!conversation) {
      const members = [a, b].sort() as [string, string];
      conversation = {
        id: randomUUID(),
        members,
        joined: new Map(),
        lastDevice: new Map(),
        bursts: [],
        floor: null,
        ring: null,
        lastRingAt: null,
        ringExpiresAt: null,
        ringTimer: null,
        rollOverTimer: null,
        rolledOver: false,
        answer: null,
        messageRecordedAt: new Map(),
        authorizedAt: null,
        authorizing: null,
        prefetch: null,
      };
      this.byPair.set(key, conversation);
      this.byId.set(conversation.id, conversation);
    }
    return conversation;
  }

  // Drop bursts that everyone has heard or that are too old.
  private pruneBursts(conversation: Conversation): void {
    const now = this.opts.now();
    conversation.bursts = conversation.bursts.filter((b) => {
      if (!b.ended) return true;
      const other = otherMember(conversation, b.from);
      // Heard: kept a little longer, only to resume a member whose stream dropped.
      if (b.deliveredTo.has(other)) return now - (b.endedAt ?? b.startedAt) < this.opts.resumeTtlMs;
      return now - b.startedAt < this.opts.bufferTtlMs;
    });
  }

  // Also forget the conversation once nobody is in it and nothing is waiting to be heard,
  // so the next Talk starts a fresh conversation (and a fresh ring).
  private prune(conversation: Conversation): void {
    this.pruneBursts(conversation);
    // Bursts kept only for resuming don't keep the conversation: nobody's in it to resume.
    const waiting = conversation.bursts.some((b) => !b.ended || !b.deliveredTo.has(otherMember(conversation, b.from)));
    if (conversation.joined.size === 0 && !waiting && !conversation.floor) {
      this.clearRing(conversation);
      this.byId.delete(conversation.id);
      this.byPair.delete(pairKey(...conversation.members));
      // The telemetry record is written now (telemetry.ts).
      this.opts.metrics.server(conversation.id, "conversationEnded", this.opts.now());
    }
  }
}

// A ring's ID: "r_" and 96 random bits.
function newRingId(): string {
  return `r_${randomBytes(12).toString("base64url")}`;
}

// Audio a conversation is holding for a member who hasn't heard it.
function bufferedBytes(conversation: Conversation): number {
  return conversation.bursts.reduce((n, b) => n + b.bytes, 0);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function otherMember(conversation: Conversation, userId: string): string {
  return conversation.members[0] === userId ? conversation.members[1] : conversation.members[0];
}
