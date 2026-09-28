// Conversation relay: floor control, burst buffering, ring-to-start pushes and replay.
// Transport-agnostic so tests can drive it with fake peers.

import { randomUUID } from "node:crypto";
import { prefetchAlert, pushToTalkRing, ringAlert, type ApnsEnvironment, type Pusher } from "./apns.ts";
import { encodeJSONRecord, encodeRecord, RecordType } from "./records.ts";
import type { DeviceStore, MetricsStore } from "./store.ts";
import type { AccountDevice, Platform, RingLookup } from "./accounts.ts";
import type { ClientMessage, RingPayload, ServerMessage } from "./protocol.ts";

// Devices registered with this token prefix are test bots: they are rung over their
// relay socket instead of through APNs.
export const LOCAL_TOKEN_PREFIX = "local:";

// Devices that can't receive pushes (the simulator, or a watch signed without the
// push entitlement) register with this prefix. Their rings are queued, and the app
// collects them with GET /v1/rings/poll while it's open.
export const POLL_TOKEN_PREFIX = "poll:";
export const PENDING_RING = "pending";

// An iPhone that isn't in its PushToTalk channel (or runs in the simulator) registers this
// token: it can be rung only while its app is on screen with the relay stream open, and the
// ring arrives over that stream.
export const IN_APP_TOKEN_PREFIX = "app:";

export interface Peer {
  userId: string;
  // The device this connection comes from (the session token's device; the user ID for
  // shared-token clients). A user can be connected from several devices at once.
  deviceId: string;
  // Signed in with a session token (an account), rather than the shared relay token. An
  // account can only ring its friends, and its rings go to its account's watches.
  account?: boolean;
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
  // Who's in the conversation, and from which of their devices.
  joined: Map<string, string>;
  // The device each member last joined or talked from. A ring later in the conversation goes
  // there first, so the device in use keeps the conversation (design decision 2026-09-27).
  lastDevice: Map<string, string>;
  bursts: Burst[];
  floor: { userId: string; burstId: string } | null;
  lastRingAt: number | null;
  // Set while a ring is waiting to be answered (or, once answered, to be joined).
  ringTimer: NodeJS.Timeout | null;
  ringFrom: string | null;
  // When each member's talking was last recorded as "last messaged you" (recordMessage).
  messageRecordedAt: Map<string, number>;
  // Prototype: the second, prefetch push for the current APNs ring (see prefetchAlert).
  prefetch: {
    to: string;
    targets: RingTarget[];
    payload: RingPayload;
    timer: NodeJS.Timeout | null;
  } | null;
}

interface RingTarget {
  deviceId: string;
  pushToken: string;
  apnsEnvironment: ApnsEnvironment;
}

type RingResult = { pushed: boolean } | { refused: "not-friends" | "unavailable" };

export interface RelayOptions {
  // Devices registered with the shared relay token (the spike's model, until every client
  // signs in).
  devices: DeviceStore;
  // Accounts: the friend check and the account's devices, once per ring.
  accounts?: {
    ringLookup(from: string, to: string): Promise<RingLookup>;
    // "Last messaged you" on the recipient's friend page; off the audio path.
    recordMessage?(from: string, to: string, at: number): Promise<void>;
  };
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
  // Prototype: after an APNs ring, send a prefetch push once the sender's first burst ends,
  // or this long after the ring if they're still talking. 0 = no prefetch pushes.
  prefetchPushAfterMs?: number;
}

export class Relay {
  // User → device → connection.
  private peers = new Map<string, Map<string, Peer>>();
  private byPair = new Map<string, Conversation>();
  private byId = new Map<string, Conversation>();
  private activeBursts = new Map<string, { conversation: Conversation; burst: Burst; deviceId: string }>();
  private polledRings = new Map<string, RingPayload[]>();
  private opts: Required<RelayOptions>;

  constructor(options: RelayOptions) {
    this.opts = {
      accounts: { ringLookup: async () => ({ allowed: false }) },
      now: Date.now,
      bufferTtlMs: 120_000,
      ringTimeoutMs: 35_000,
      answerJoinTimeoutMs: 30_000,
      prefetchPushAfterMs: 0,
      ...options,
    };
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
        if (conversation?.joined.get(peer.userId) === peer.deviceId) this.leave(peer.userId, conversation);
        break;
      }
      default:
        peer.sendJSON({ type: "error", message: `unknown message type` });
    }
  }

  handleAudio(peer: Peer, frame: Buffer): void {
    const active = this.activeBursts.get(peer.userId);
    if (!active || active.deviceId !== peer.deviceId) return;
    const { conversation, burst } = active;
    burst.frames.push(frame);
    const other = otherMember(conversation, peer.userId);
    if (burst.deliveredTo.has(other)) {
      this.memberPeer(conversation, other)?.sendBinary(frame);
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
      joined: [...c.joined.keys()],
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

    this.enter(conversation, peer);
    if (peer.account) this.recordMessage(conversation, from, to, now);
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
    this.activeBursts.set(from, { conversation, burst, deviceId: peer.deviceId });
    this.opts.metrics.server(conversation.id, "talkStart", now, `${from} -> ${to}`);

    if (this.memberPeer(conversation, to)) {
      this.startDelivery(conversation, burst, to, false);
      this.grantFloor(peer, conversation, burstId, false);
    } else if (!conversation.ringTimer) {
      // One ring per conversation start; further bursts queue behind the pending ring.
      // The ring looks the devices up in the store, so only a Talk that rings waits for
      // the store. Frames that arrive meanwhile are buffered in the burst as usual.
      void this.ring(conversation, from, to, burstId, peer.account === true).then((result) => {
        if ("refused" in result) this.refuse(peer, conversation, burstId, result.refused);
        else this.grantFloor(peer, conversation, burstId, result.pushed);
      });
    } else {
      this.grantFloor(peer, conversation, burstId, false);
    }
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

  // Not friends, or none of their devices can be rung: drop everything the sender has queued in
  // this conversation, unring, and say why. Frames still arriving for the burst are ignored.
  private refuse(peer: Peer, conversation: Conversation, burstId: string, reason: "not-friends" | "unavailable"): void {
    const from = peer.userId;
    if (this.activeBursts.get(from)?.conversation === conversation) this.activeBursts.delete(from);
    conversation.bursts = conversation.bursts.filter((b) => b.from !== from);
    if (conversation.floor?.userId === from) conversation.floor = null;
    conversation.joined.delete(from);
    peer.sendJSON({ type: "talk-refused", burstId, reason });
    this.prune(conversation);
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
      this.memberPeer(conversation, member)?.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
    }
    if (conversation.prefetch && burst.from !== conversation.prefetch.to) this.sendPrefetchPush(conversation);
    this.prune(conversation);
  }

  // The buffered message a ring's recipient hasn't heard yet, as stream records (burst-start,
  // frames, burst-end if it has ended), for the watch's notification service extension to
  // download before the tap. Read-only: the join still replays it, and the app skips the
  // frames it already played.
  bufferedAudio(userId: string, conversationId: string): { records: Buffer; bursts: number; frames: number } | null {
    const conversation = this.byId.get(conversationId);
    if (!conversation || !conversation.members.includes(userId)) return null;
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
    return { records: Buffer.concat(parts), bursts, frames };
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
    this.enter(conversation, peer);
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
    this.memberPeer(conversation, other)?.sendJSON({ type: "peer-left", conversationId: conversation.id, peer: userId });
    this.prune(conversation);
  }

  private startDelivery(conversation: Conversation, burst: Burst, to: string, replay: boolean): void {
    const peer = this.memberPeer(conversation, to);
    if (!peer) return;
    burst.deliveredTo.add(to);
    peer.sendJSON({ type: "burst-start", conversationId: conversation.id, burstId: burst.id, from: burst.from, replay });
    if (replay) {
      this.opts.metrics.server(conversation.id, "replayStarted", this.opts.now(), `${burst.frames.length} frames`);
    }
    for (const frame of burst.frames) peer.sendBinary(frame);
    if (burst.ended) peer.sendJSON({ type: "burst-end", conversationId: conversation.id, burstId: burst.id });
  }

  private async ring(conversation: Conversation, from: string, to: string, burstId: string, account: boolean): Promise<RingResult> {
    // Armed before the lookup, so a second Talk meanwhile doesn't ring again.
    conversation.ringFrom = from;
    this.armRingTimer(conversation, to, this.opts.ringTimeoutMs);
    let lookup: RingLookup;
    try {
      lookup = account ? await this.opts.accounts.ringLookup(from, to) : await this.legacyLookup(from, to);
    } catch (err) {
      this.clearRing(conversation);
      this.opts.metrics.server(conversation.id, "pushFailed", this.opts.now(), `device lookup: ${(err as Error).message}`);
      console.error(`[relay] device lookup for ${to} failed: ${(err as Error).message}`);
      return { pushed: false };
    }
    if (!lookup.allowed) {
      this.clearRing(conversation);
      this.opts.metrics.server(conversation.id, "ringRefused", this.opts.now(), "not friends");
      return { refused: "not-friends" };
    }
    // Answered, or the relay is shutting down, during the lookup.
    if (!conversation.ringTimer) return { pushed: false };
    const targets = this.ringTargets(conversation, to, lookup.devices, lookup.ringOn);
    if (!targets.length) {
      this.clearRing(conversation);
      this.opts.metrics.server(conversation.id, "pushSkipped", this.opts.now(), `no device for ${to}`);
      // An account learns at once that nobody will hear it; shared-token clients never did.
      return account ? { refused: "unavailable" } : { pushed: false };
    }
    conversation.lastRingAt = this.opts.now();
    this.armRingTimer(conversation, to, this.opts.ringTimeoutMs);
    const payload: RingPayload = {
      conversationId: conversation.id,
      from,
      fromName: lookup.fromName,
      burstId,
      pushSentAt: conversation.lastRingAt,
    };
    const platform = targets[0].platform;
    this.opts.metrics.server(conversation.id, "pushSent", conversation.lastRingAt, `${platform}${targets.length > 1 ? `, ${targets.length} devices` : ""}`);
    const apnsTargets: RingTarget[] = [];
    let pushed = false;
    for (const target of targets) {
      if (target.pushToken.startsWith(LOCAL_TOKEN_PREFIX) || target.pushToken.startsWith(IN_APP_TOKEN_PREFIX)) {
        // Over the device's open relay stream (a test bot's, or an iPhone app on screen).
        const peer = this.devicePeer(to, target.id) ?? this.anyPeer(to);
        peer?.sendJSON({ type: "ring", ...payload });
        this.opts.metrics.server(conversation.id, peer ? "pushAccepted" : "pushFailed", this.opts.now(), target.pushToken.startsWith(LOCAL_TOKEN_PREFIX) ? "local ring" : "in-app ring");
        pushed ||= peer !== undefined;
      } else if (target.pushType === "pushtotalk") {
        this.sendPush(conversation, to, target, pushToTalkRing(payload), "pushtotalk");
        pushed = true;
      } else if (target.pushToken.startsWith(POLL_TOKEN_PREFIX)) {
        this.polledRings.set(to, [...(this.polledRings.get(to) ?? []), payload]);
        this.opts.metrics.server(conversation.id, "pushAccepted", this.opts.now(), "queued for polling");
        pushed = true;
      } else {
        apnsTargets.push({ deviceId: target.id, pushToken: target.pushToken, apnsEnvironment: target.apnsEnvironment });
      }
    }
    if (!apnsTargets.length) return { pushed };
    const push = ringAlert(payload, conversation.lastRingAt + this.opts.ringTimeoutMs);
    if (this.opts.prefetchPushAfterMs > 0) {
      this.clearPrefetch(conversation);
      conversation.prefetch = { to, targets: apnsTargets, payload, timer: null };
      conversation.prefetch.timer = setTimeout(() => this.sendPrefetchPush(conversation), this.opts.prefetchPushAfterMs);
      conversation.prefetch.timer.unref();
    }
    for (const target of apnsTargets) this.sendPush(conversation, to, target, push, "alert");
    return { pushed: true };
  }

  private sendPush(conversation: Conversation, to: string, target: { pushToken: string; apnsEnvironment: ApnsEnvironment }, push: ReturnType<typeof ringAlert>, kind: string): void {
    void this.opts.pusher.sendAlert(target.pushToken, target.apnsEnvironment, push).then((result) => {
      const detail = `${kind}: status ${result.status}${result.reason ? ` ${result.reason}` : ""} in ${result.latencyMs.toFixed(0)} ms${result.dryRun ? " (dry run)" : ""}`;
      this.opts.metrics.server(conversation.id, result.ok ? "pushAccepted" : "pushFailed", this.opts.now(), detail);
      if (!result.ok) console.error(`[relay] push to ${to} failed: ${detail}`);
    });
  }

  private anyPeer(userId: string): Peer | undefined {
    return this.peers.get(userId)?.values().next().value;
  }

  // Which of the recipient's devices ring (design decision 2026-09-27): only one kind, never
  // both. The device they last used in this conversation first, if it can be rung; then their
  // choice (ringOn; unset = the watch if they have one); then the other kind.
  private ringTargets(conversation: Conversation, to: string, devices: AccountDevice[], ringOn: Platform | undefined): AccountDevice[] {
    const reachable = devices.filter((d) => this.canRing(to, d));
    const last = conversation.lastDevice.get(to);
    const sticky = reachable.find((d) => d.id === last);
    if (sticky) return [sticky];
    const hasWatch = devices.some((d) => d.platform === "watch" && d.pushToken);
    const first: Platform = ringOn ?? (hasWatch ? "watch" : "iphone");
    for (const platform of [first, first === "watch" ? "iphone" : "watch"] as const) {
      const targets = reachable.filter((d) => d.platform === platform);
      if (targets.length) return targets;
    }
    return [];
  }

  private canRing(userId: string, device: AccountDevice): boolean {
    if (!device.pushToken) return false;
    // In-app rings need the app on screen, which is when its stream is open.
    if (device.pushToken.startsWith(IN_APP_TOKEN_PREFIX)) return this.devicePeer(userId, device.id) !== undefined;
    return true;
  }

  // Shared-token clients: any registered device can be rung, as in the spike.
  private async legacyLookup(from: string, to: string): Promise<RingLookup> {
    const [device, sender] = await Promise.all([this.opts.devices.get(to), this.opts.devices.get(from)]);
    return {
      allowed: true,
      fromName: sender?.name ?? from,
      devices: device ? [{ id: device.userId, platform: "watch", pushToken: device.pushToken, pushType: "alert", apnsEnvironment: device.apnsEnvironment, updatedAt: device.updatedAt }] : [],
    };
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
    this.memberPeer(conversation, from)?.sendJSON({
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
    if (conversation.joined.has(prefetch.to) || !conversation.ringTimer || conversation.lastRingAt === null) return;
    const push = prefetchAlert(prefetch.payload, conversation.lastRingAt + this.opts.ringTimeoutMs);
    this.opts.metrics.server(conversation.id, "prefetchPushSent", this.opts.now());
    for (const target of prefetch.targets) {
      void this.opts.pusher.sendAlert(target.pushToken, target.apnsEnvironment, push).then((result) => {
        const detail = `status ${result.status}${result.reason ? ` ${result.reason}` : ""} in ${result.latencyMs.toFixed(0)} ms${result.dryRun ? " (dry run)" : ""}`;
        this.opts.metrics.server(conversation.id, result.ok ? "prefetchPushAccepted" : "prefetchPushFailed", this.opts.now(), detail);
      });
    }
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
        lastRingAt: null,
        ringTimer: null,
        ringFrom: null,
        messageRecordedAt: new Map(),
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
