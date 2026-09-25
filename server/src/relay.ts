// Conversation relay: floor control, burst buffering, ring-to-start pushes and replay.
// Transport-agnostic so tests can drive it with fake peers.

import { randomUUID } from "node:crypto";
import { ringAlert, type Pusher } from "./apns.ts";
import type { DeviceStore, MetricsStore } from "./store.ts";
import type { ClientMessage, RingPayload, ServerMessage } from "./protocol.ts";

// Devices registered with this token prefix are test bots: they are rung over their
// relay socket instead of through APNs.
export const LOCAL_TOKEN_PREFIX = "local:";

// Devices that can't receive pushes (the simulator, or a watch signed without the
// push entitlement) register with this prefix. Their rings are queued, and the app
// collects them with GET /v1/rings/poll while it's open.
export const POLL_TOKEN_PREFIX = "poll:";
export const PENDING_RING = "pending";

export interface Peer {
  userId: string;
  sendJSON(message: ServerMessage): void;
  sendBinary(frame: Buffer): void;
}

interface Burst {
  id: string;
  from: string;
  frames: Buffer[];
  ended: boolean;
  startedAt: number;
  // Members this burst has started playing for; later frames are forwarded live to them.
  deliveredTo: Set<string>;
  firstLiveFrameLogged: boolean;
}

interface Conversation {
  id: string;
  members: [string, string];
  joined: Set<string>;
  bursts: Burst[];
  floor: { userId: string; burstId: string } | null;
  lastRingAt: number | null;
  // Set while a ring is waiting to be answered (or, once answered, to be joined).
  ringTimer: NodeJS.Timeout | null;
  ringFrom: string | null;
}

export interface RelayOptions {
  devices: DeviceStore;
  pusher: Pusher;
  metrics: MetricsStore;
  now?: () => number;
  // Backstop for audio that was never rung (for example, no registered device).
  bufferTtlMs?: number;
  // An unanswered ring is abandoned after this long and its unheard audio dropped.
  // Slightly longer than the watch's 30 s ring, so a late push that's still answered
  // in time doesn't lose the message. (Design decision: unheard messages are dropped
  // rather than kept as clips; see the feasibility doc's "Design decisions".)
  ringTimeoutMs?: number;
  // After the watch reports it answered, how long it has to open the relay socket and
  // join before the ring is abandoned. Socket setup on a real watch took ~7 s.
  answerJoinTimeoutMs?: number;
}

export class Relay {
  private peers = new Map<string, Peer>();
  private byPair = new Map<string, Conversation>();
  private byId = new Map<string, Conversation>();
  private activeBursts = new Map<string, { conversation: Conversation; burst: Burst }>();
  private polledRings = new Map<string, RingPayload[]>();
  private opts: Required<RelayOptions>;

  constructor(options: RelayOptions) {
    this.opts = { now: Date.now, bufferTtlMs: 120_000, ringTimeoutMs: 35_000, answerJoinTimeoutMs: 30_000, ...options };
  }

  close(): void {
    for (const conversation of this.byId.values()) this.clearRing(conversation);
  }

  connect(peer: Peer): void {
    const previous = this.peers.get(peer.userId);
    if (previous && previous !== peer) this.disconnect(previous);
    this.peers.set(peer.userId, peer);
  }

  disconnect(peer: Peer): void {
    if (this.peers.get(peer.userId) !== peer) return;
    this.peers.delete(peer.userId);
    this.endActiveBurst(peer.userId);
    for (const conversation of [...this.byId.values()]) {
      if (conversation.joined.has(peer.userId)) this.leave(peer.userId, conversation);
    }
  }

  handleMessage(peer: Peer, message: ClientMessage): void {
    switch (message.type) {
      case "hello":
        peer.sendJSON({ type: "hello-ack", clientTime: message.clientTime, serverTime: this.opts.now() });
        break;
      case "talk-start":
        this.talkStart(peer, message.to, message.burstId);
        break;
      case "talk-end":
        this.talkEnd(peer.userId, message.burstId);
        break;
      case "join":
        this.join(peer, message.conversationId);
        break;
      case "leave": {
        const conversation = this.byId.get(message.conversationId);
        if (conversation?.joined.has(peer.userId)) this.leave(peer.userId, conversation);
        break;
      }
      default:
        peer.sendJSON({ type: "error", message: `unknown message type` });
    }
  }

  handleAudio(peer: Peer, frame: Buffer): void {
    const active = this.activeBursts.get(peer.userId);
    if (!active) return;
    const { conversation, burst } = active;
    burst.frames.push(frame);
    const other = otherMember(conversation, peer.userId);
    if (burst.deliveredTo.has(other)) {
      this.peers.get(other)?.sendBinary(frame);
      if (!burst.firstLiveFrameLogged) {
        burst.firstLiveFrameLogged = true;
        this.opts.metrics.server(conversation.id, "firstFrameForwardedLive", this.opts.now());
      }
    }
  }

  // Rings queued for a polling device, removed as they're collected.
  // Collecting a ring is when the watch starts ringing, so the timeout restarts then.
  takePolledRings(userId: string): RingPayload[] {
    const rings = this.polledRings.get(userId) ?? [];
    this.polledRings.delete(userId);
    for (const ring of rings) {
      const conversation = this.byId.get(ring.conversationId);
      if (!conversation?.ringTimer) continue;
      this.opts.metrics.server(conversation.id, "ringCollected", this.opts.now());
      this.armRingTimer(conversation, userId, this.opts.ringTimeoutMs);
    }
    return rings;
  }

  // The watch answered (reported over HTTPS, which works before its socket can open).
  // Keep the buffered audio and give it time to connect and join.
  answered(userId: string, conversationId: string): boolean {
    const conversation = this.byId.get(conversationId);
    if (!conversation || !conversation.members.includes(userId)) return false;
    this.opts.metrics.server(conversation.id, "answerReported", this.opts.now());
    if (conversation.ringTimer && !conversation.joined.has(userId)) {
      this.armRingTimer(conversation, userId, this.opts.answerJoinTimeoutMs);
    }
    return true;
  }

  // Exposed for tests and the status endpoint.
  snapshot(): Array<{ id: string; members: string[]; joined: string[]; bufferedBursts: number; floor: string | null }> {
    return [...this.byId.values()].map((c) => ({
      id: c.id,
      members: [...c.members],
      joined: [...c.joined],
      bufferedBursts: c.bursts.length,
      floor: c.floor?.userId ?? null,
    }));
  }

  private talkStart(peer: Peer, to: string, burstId: string): void {
    const from = peer.userId;
    const now = this.opts.now();
    if (to === from) {
      peer.sendJSON({ type: "error", message: "cannot talk to yourself" });
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

    conversation.joined.add(from);
    const burst: Burst = {
      id: burstId,
      from,
      frames: [],
      ended: false,
      startedAt: now,
      deliveredTo: new Set(),
      firstLiveFrameLogged: false,
    };
    conversation.bursts.push(burst);
    conversation.floor = { userId: from, burstId };
    this.activeBursts.set(from, { conversation, burst });
    this.opts.metrics.server(conversation.id, "talkStart", now, `${from} -> ${to}`);

    let pushed = false;
    if (conversation.joined.has(to) && this.peers.has(to)) {
      this.startDelivery(conversation, burst, to, false);
    } else if (!conversation.ringTimer) {
      // One ring per conversation start; further bursts queue behind the pending ring.
      pushed = this.ring(conversation, from, to, burstId);
    }
    peer.sendJSON({ type: "floor-granted", burstId, conversationId: conversation.id, pushed });
    this.opts.metrics.server(conversation.id, "floorGrantSent", this.opts.now(), from);
  }

  private talkEnd(userId: string, burstId: string): void {
    const active = this.activeBursts.get(userId);
    if (!active || active.burst.id !== burstId) return;
    this.endActiveBurst(userId);
  }

  private endActiveBurst(userId: string): void {
    const active = this.activeBursts.get(userId);
    if (!active) return;
    this.activeBursts.delete(userId);
    const { conversation, burst } = active;
    burst.ended = true;
    if (conversation.floor?.burstId === burst.id) conversation.floor = null;
    for (const member of burst.deliveredTo) {
      this.peers.get(member)?.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
    }
    this.prune(conversation);
  }

  // conversationId "pending" joins the user's newest queued ring instead, for the watch's
  // local-notification test, which can't know the ID in advance.
  private join(peer: Peer, conversationId: string): void {
    if (conversationId === PENDING_RING) {
      const newest = this.takePolledRings(peer.userId).at(-1);
      if (!newest) return peer.sendJSON({ type: "error", message: "no pending ring" });
      conversationId = newest.conversationId;
    }
    const conversation = this.byId.get(conversationId);
    if (!conversation || !conversation.members.includes(peer.userId)) {
      peer.sendJSON({ type: "error", message: "unknown conversation" });
      return;
    }
    const now = this.opts.now();
    this.pruneBursts(conversation);
    conversation.joined.add(peer.userId);
    this.clearRing(conversation);
    const pending = conversation.bursts.filter((b) => b.from !== peer.userId && !b.deliveredTo.has(peer.userId));
    const other = otherMember(conversation, peer.userId);
    peer.sendJSON({ type: "joined", conversationId, peer: other, replayBursts: pending.length });
    this.opts.metrics.server(conversation.id, "receiverJoined", now, `${pending.length} buffered`);
    for (const burst of pending) this.startDelivery(conversation, burst, peer.userId, true);
  }

  private leave(userId: string, conversation: Conversation): void {
    conversation.joined.delete(userId);
    if (conversation.floor?.userId === userId) this.endActiveBurst(userId);
    const other = otherMember(conversation, userId);
    if (conversation.joined.has(other)) {
      this.peers.get(other)?.sendJSON({ type: "peer-left", conversationId: conversation.id, peer: userId });
    }
    this.prune(conversation);
  }

  private startDelivery(conversation: Conversation, burst: Burst, to: string, replay: boolean): void {
    const peer = this.peers.get(to);
    if (!peer) return;
    burst.deliveredTo.add(to);
    peer.sendJSON({ type: "burst-start", conversationId: conversation.id, burstId: burst.id, from: burst.from, replay });
    if (replay) {
      this.opts.metrics.server(conversation.id, "replayStarted", this.opts.now(), `${burst.frames.length} frames`);
    }
    for (const frame of burst.frames) peer.sendBinary(frame);
    if (burst.ended) peer.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
  }

  private ring(conversation: Conversation, from: string, to: string, burstId: string): boolean {
    const device = this.opts.devices.get(to);
    if (!device) {
      this.opts.metrics.server(conversation.id, "pushSkipped", this.opts.now(), `no device for ${to}`);
      return false;
    }
    conversation.lastRingAt = this.opts.now();
    conversation.ringFrom = from;
    this.armRingTimer(conversation, to, this.opts.ringTimeoutMs);
    const payload: RingPayload = {
      conversationId: conversation.id,
      from,
      fromName: this.opts.devices.get(from)?.name ?? from,
      burstId,
      pushSentAt: conversation.lastRingAt,
    };
    this.opts.metrics.server(conversation.id, "pushSent", conversation.lastRingAt);
    if (device.pushToken.startsWith(LOCAL_TOKEN_PREFIX)) {
      const peer = this.peers.get(to);
      peer?.sendJSON({ type: "ring", ...payload });
      this.opts.metrics.server(conversation.id, peer ? "pushAccepted" : "pushFailed", this.opts.now(), "local ring");
      return peer !== undefined;
    }
    if (device.pushToken.startsWith(POLL_TOKEN_PREFIX)) {
      this.polledRings.set(to, [...(this.polledRings.get(to) ?? []), payload]);
      this.opts.metrics.server(conversation.id, "pushAccepted", this.opts.now(), "queued for polling");
      return true;
    }
    const push = ringAlert(payload, conversation.lastRingAt + this.opts.ringTimeoutMs);
    void this.opts.pusher.sendAlert(device.pushToken, device.apnsEnvironment, push).then((result) => {
      const detail = `status ${result.status}${result.reason ? ` ${result.reason}` : ""} in ${result.latencyMs.toFixed(0)} ms${result.dryRun ? " (dry run)" : ""}`;
      this.opts.metrics.server(conversation.id, result.ok ? "pushAccepted" : "pushFailed", this.opts.now(), detail);
      if (!result.ok) console.error(`[relay] push to ${to} failed: ${detail}`);
    });
    return true;
  }

  // Nobody answered: drop what they didn't hear and tell the sender, so the next Talk
  // starts a fresh ring instead of replaying stale audio.
  private ringTimedOut(conversation: Conversation, from: string, to: string): void {
    conversation.ringTimer = null;
    // A polling device that wasn't open to collect the ring shouldn't ring later for it.
    const queued = (this.polledRings.get(to) ?? []).filter((r) => r.conversationId !== conversation.id);
    if (queued.length) this.polledRings.set(to, queued);
    else this.polledRings.delete(to);
    if (conversation.joined.has(to)) return;
    const unheard = conversation.bursts.filter((b) => b.from !== to && !b.deliveredTo.has(to));
    conversation.bursts = conversation.bursts.filter((b) => !unheard.includes(b));
    const frames = unheard.reduce((n, b) => n + b.frames.length, 0);
    this.opts.metrics.server(conversation.id, "ringTimedOut", this.opts.now(), `dropped ${unheard.length} bursts (${frames} frames)`);
    this.peers.get(from)?.sendJSON({
      type: "ring-timeout",
      conversationId: conversation.id,
      peer: to,
      droppedBursts: unheard.length,
    });
    this.prune(conversation);
  }

  private armRingTimer(conversation: Conversation, to: string, ms: number): void {
    if (conversation.ringTimer) clearTimeout(conversation.ringTimer);
    const from = conversation.ringFrom ?? otherMember(conversation, to);
    conversation.ringTimer = setTimeout(() => this.ringTimedOut(conversation, from, to), ms);
    conversation.ringTimer.unref();
  }

  private clearRing(conversation: Conversation): void {
    if (conversation.ringTimer) clearTimeout(conversation.ringTimer);
    conversation.ringTimer = null;
  }

  private conversationFor(a: string, b: string): Conversation {
    const key = pairKey(a, b);
    let conversation = this.byPair.get(key);
    if (!conversation) {
      const members = [a, b].sort() as [string, string];
      conversation = {
        id: randomUUID(),
        members,
        joined: new Set(),
        bursts: [],
        floor: null,
        lastRingAt: null,
        ringTimer: null,
        ringFrom: null,
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
      return !b.deliveredTo.has(other) && now - b.startedAt < this.opts.bufferTtlMs;
    });
  }

  // Also forget the conversation once nobody is in it and nothing is waiting to be heard,
  // so the next Talk starts a fresh conversation (and a fresh ring).
  private prune(conversation: Conversation): void {
    this.pruneBursts(conversation);
    if (conversation.joined.size === 0 && conversation.bursts.length === 0 && !conversation.floor) {
      this.clearRing(conversation);
      this.byId.delete(conversation.id);
      this.byPair.delete(pairKey(...conversation.members));
    }
  }
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function otherMember(conversation: Conversation, userId: string): string {
  return conversation.members[0] === userId ? conversation.members[1] : conversation.members[0];
}
