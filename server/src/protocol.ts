// Wire protocol for the relay WebSocket. Control messages are JSON text frames;
// audio travels as binary frames the relay forwards without decoding.
//
// Binary audio frame layout (big-endian):
//   byte 0      codec (see Codec)
//   bytes 1..4  sequence number within the burst (uint32)
//   bytes 5..   codec payload (one 20 ms packet)

export const Codec = {
  opus16k: 1,
  pcm16le16k: 2,
} as const;

export const FRAME_HEADER_BYTES = 5;
export const FRAME_MS = 20;
// One 20 ms frame of 16 kHz mono PCM16 is 320 samples; the apps pad the last one.
export const PCM_FRAME_BYTES = 640;
// The largest Opus packet (RFC 6716).
export const MAX_OPUS_PACKET_BYTES = 1275;

// A frame the apps can decode: a known codec and a payload of the right size for it. The
// relay drops anything else rather than forward it to a decoder.
export function isValidFrame(frame: Buffer): boolean {
  const payload = frame.length - FRAME_HEADER_BYTES;
  switch (frame[0]) {
    case Codec.pcm16le16k: return payload === PCM_FRAME_BYTES;
    case Codec.opus16k: return payload > 0 && payload <= MAX_OPUS_PACKET_BYTES;
    default: return false;
  }
}

export type CodecId = (typeof Codec)[keyof typeof Codec];

// Relay protocol 2 (contracts/README.md): the codec is named at talk-start and the ring when
// joining.
export type ClientMessage =
  // First message after connecting. clientTime lets the client estimate clock offset.
  | { type: "hello"; clientTime: number }
  // Sender pressed Talk. Joins the sender to the conversation with `to`. codec: the burst's.
  | { type: "talk-start"; to: string; burstId: string; codec: CodecId }
  | { type: "talk-end"; burstId: string }
  // Receiver answered the ring: replay anything buffered, then go live. ringId: the ring being
  // answered (none for a rejoin or a move).
  // resume: a rejoin after the stream dropped mid-burst; replays that burst from fromSeq.
  | { type: "join"; conversationId: string; ringId?: string; resume?: { burstId: string; fromSeq: number } }
  | { type: "leave"; conversationId: string };

const MAX_ID_LENGTH = 128;
const RING_ID = /^r_[\w-]{1,64}$/;

export function isRingId(value: unknown): value is string {
  return typeof value === "string" && RING_ID.test(value);
}

// A client message checked field by field (clients are untrusted), or null. Strict about what
// the contract requires (talk-start's codec); unknown fields are ignored.
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
  switch (m.type) {
    case "hello":
      return typeof m.clientTime === "number" && Number.isFinite(m.clientTime) ? { type: "hello", clientTime: m.clientTime } : null;
    case "talk-start": {
      if (!id(m.to) || !id(m.burstId)) return null;
      const codec = m.codec === "opus16k" ? Codec.opus16k : m.codec === "pcm16le16k" ? Codec.pcm16le16k : undefined;
      if (codec === undefined) return null;
      return { type: "talk-start", to: m.to, burstId: m.burstId, codec };
    }
    case "talk-end":
      return id(m.burstId) ? { type: "talk-end", burstId: m.burstId } : null;
    case "join": {
      if (!id(m.conversationId)) return null;
      if (m.ringId !== undefined && !isRingId(m.ringId)) return null;
      const r = m.resume as Record<string, unknown> | undefined;
      const resume = r && typeof r === "object" && id(r.burstId) && Number.isInteger(r.fromSeq) && (r.fromSeq as number) >= 0
        ? { burstId: r.burstId, fromSeq: r.fromSeq as number }
        : undefined;
      const ringId = isRingId(m.ringId) ? m.ringId : undefined;
      return { type: "join", conversationId: m.conversationId, ...(ringId ? { ringId } : {}), ...(resume ? { resume } : {}) };
    }
    case "leave":
      return id(m.conversationId) ? { type: m.type, conversationId: m.conversationId } : null;
    default:
      return null;
  }
}

// Error codes in an "error" message (contracts/README.md).
export type RelayErrorCode =
  | "ring-expired"
  | "ring-answered-elsewhere"
  | "unknown-conversation"
  | "unsupported-codec"
  | "burst-too-long"
  | "too-much-audio"
  | "unknown-message";

export type ServerMessage =
  | { type: "hello-ack"; clientTime: number; serverTime: number }
  | { type: "floor-granted"; burstId: string; conversationId: string; pushed: boolean }
  | { type: "floor-denied"; burstId: string; holder: string }
  // The burst was dropped and nobody was rung: not friends (an account can only ring its
  // friends), none of the friend's devices can be rung right now, or the listener can't play
  // the burst's codec.
  | { type: "talk-refused"; burstId: string; reason: "not-friends" | "unavailable" | "unsupported-codec" }
  // The user joined or talked in this conversation from another of their devices, which now
  // has it; this device should end its side.
  | { type: "moved"; conversationId: string }
  // resumedFrames: on a rejoin with resume, how many frames of that burst are replayed.
  | { type: "joined"; conversationId: string; peer: string; replayBursts: number; resumedFrames?: number; ringId?: string }
  | { type: "burst-start"; conversationId: string; burstId: string; from: string; replay: boolean; resumed?: boolean; codec?: string }
  | { type: "burst-end"; conversationId: string; burstId: string }
  | { type: "peer-left"; conversationId: string; peer: string }
  // The two may no longer talk (a block, an unfriending or a deleted account): the relay
  // dropped the conversation and its audio.
  | { type: "conversation-ended"; conversationId: string; reason: "not-friends" }
  // The ring went unanswered; the sender's unheard audio was dropped.
  | { type: "ring-timeout"; conversationId: string; peer: string; droppedBursts: number }
  // A ring over the open relay stream (an app on screen, or a test bot).
  | ({ type: "ring" } & RingPayload)
  // The session behind this connection ended (signed out, revoked, account deleted); the
  // connection closes next.
  | { type: "session-ended" }
  // HTTP transport keepalive; clients ignore it.
  | { type: "ping" }
  | { type: "error"; message: string; code: RelayErrorCode };

// Timing events are posted over HTTPS (POST /v2/metrics) rather than the socket,
// because watchOS only allows the socket while the CallKit call is up.
export interface MetricEvent {
  name: string;
  // Milliseconds since epoch in the reporting device's clock.
  t: number;
  detail?: string;
}

export interface MetricsUpload {
  conversationId: string;
  userId: string;
  role: "sender" | "receiver";
  // serverTime - deviceTime, estimated from hello/hello-ack.
  clockOffsetMs: number;
  events: MetricEvent[];
}

// The ring envelope (contracts/README.md), the same in the in-app "ring" message, APNs payloads
// (custom keys) and later FCM data.
export interface RingPayload {
  schemaVersion: 2;
  // New for each ring; kept when the same ring goes to another device.
  ringId: string;
  conversationId: string;
  from: string;
  fromName: string;
  burstId: string;
  // When this push was sent (server clock, ms).
  pushSentAt: number;
  // When the unanswered ring is abandoned (server clock, ms).
  expiresAt: number;
}
