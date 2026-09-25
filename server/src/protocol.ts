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

export type ClientMessage =
  // First message after connecting. clientTime lets the client estimate clock offset.
  | { type: "hello"; clientTime: number }
  // Sender pressed Talk. Joins the sender to the conversation with `to`.
  | { type: "talk-start"; to: string; burstId: string }
  | { type: "talk-end"; burstId: string }
  // Receiver answered the ring: replay anything buffered, then go live.
  | { type: "join"; conversationId: string }
  | { type: "leave"; conversationId: string };

export type ServerMessage =
  | { type: "hello-ack"; clientTime: number; serverTime: number }
  | { type: "floor-granted"; burstId: string; conversationId: string; pushed: boolean }
  | { type: "floor-denied"; burstId: string; holder: string }
  | { type: "joined"; conversationId: string; peer: string; replayBursts: number }
  | { type: "burst-start"; conversationId: string; burstId: string; from: string; replay: boolean }
  | { type: "burst-end"; conversationId: string; burstId: string }
  | { type: "peer-left"; conversationId: string; peer: string }
  // The ring went unanswered; the sender's unheard audio was dropped.
  | { type: "ring-timeout"; conversationId: string; peer: string; droppedBursts: number }
  // Stand-in for the ring push, used for test bots registered with a "local:" token.
  | ({ type: "ring" } & RingPayload)
  // HTTP transport keepalive; clients ignore it.
  | { type: "ping" }
  | { type: "error"; message: string };

// Timing events are posted over HTTPS (POST /v1/metrics) rather than the socket,
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

// Ring details, sent as custom keys in the alert push (see ringAlert in apns.ts), or as a
// "ring" message to test bots.
export interface RingPayload {
  conversationId: string;
  from: string;
  fromName: string;
  burstId: string;
  pushSentAt: number;
}
