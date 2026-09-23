// Framing for the HTTP relay transport, used by watches once the CallKit call has ended
// (watchOS blocks WebSockets outside a call, but allows ordinary HTTPS requests).
//
// The same records flow both ways: down a long-lived streaming GET response, and up in
// short POST bodies. Each record is:
//   byte 0      type (RecordType)
//   bytes 1..4  payload length (uint32, big-endian)
//   bytes 5..   payload: UTF-8 JSON for control messages, or one audio frame as sent on
//               the WebSocket (see protocol.ts)

export const RecordType = {
  json: 1,
  audio: 2,
} as const;

export type RecordTypeValue = (typeof RecordType)[keyof typeof RecordType];

export interface WireRecord {
  type: RecordTypeValue;
  payload: Buffer;
}

const HEADER_BYTES = 5;
const MAX_PAYLOAD_BYTES = 1 << 20;

export function encodeRecord(type: RecordTypeValue, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeJSONRecord(value: unknown): Buffer {
  return encodeRecord(RecordType.json, Buffer.from(JSON.stringify(value), "utf8"));
}

// Incremental parser: feed it chunks as they arrive, get back complete records.
export class RecordParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): WireRecord[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const records: WireRecord[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const type = this.pending[0];
      const length = this.pending.readUInt32BE(1);
      if ((type !== RecordType.json && type !== RecordType.audio) || length > MAX_PAYLOAD_BYTES) {
        throw new Error(`bad record (type ${type}, length ${length})`);
      }
      if (this.pending.length < HEADER_BYTES + length) break;
      records.push({ type, payload: Buffer.from(this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length)) });
      this.pending = this.pending.subarray(HEADER_BYTES + length);
    }
    return records;
  }
}
