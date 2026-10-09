// Writes contracts/fixtures/frames.json and records.json: the binary audio format 1 layout (which
// format 2 keeps, sealing the payload; format 1 itself is no longer carried) and the HTTPS
// transport's records, as hex, for every client's tests. The Opus packets are real ones
// from macOS's encoder (the Test Bot's greeting), so a decoder on another platform can prove it
// plays Apple's packets. Run again only if the format changes (it mustn't):
//   node tools/contract-fixtures.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Codec, FRAME_HEADER_BYTES, FRAME_TAG_BYTES, isValidFrame } from "../src/protocol.ts";
import { RecordType, encodeJSONRecord, encodeRecord } from "../src/records.ts";
import { loadGreeting } from "../src/test-bot.ts";

const out = join(import.meta.dirname!, "..", "..", "contracts", "fixtures");

function frame(codec: number, seq: number, payload: Buffer): Buffer {
  const f = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
  f[0] = codec;
  f.writeUInt32BE(seq, 1);
  payload.copy(f, FRAME_HEADER_BYTES);
  return f;
}

// A 440 Hz tone at -20 dBFS: one 20 ms frame of 16 kHz mono PCM16 little-endian.
function tone(): Buffer {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round(3277 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  return b;
}

const greeting = loadGreeting();
const frames = [
  ...greeting.slice(0, 3).map((p, seq) => ({ name: `opus-apple-${seq}`, codec: "opus16k", seq, payloadBytes: p.length, frame: frame(Codec.opus16k, seq, p) })),
  { name: "pcm-tone", codec: "pcm16le16k", seq: 7, payloadBytes: 640, frame: frame(Codec.pcm16le16k, 7, tone()) },
  { name: "opus-high-seq", codec: "opus16k", seq: 0xfffffffe, payloadBytes: greeting[3].length, frame: frame(Codec.opus16k, 0xfffffffe, greeting[3]) },
  { name: "malformed-unknown-codec", frame: frame(3, 0, Buffer.alloc(40, 1)) },
  { name: "malformed-pcm-short", frame: frame(Codec.pcm16le16k, 0, Buffer.alloc(639)) },
  { name: "malformed-opus-empty", frame: frame(Codec.opus16k, 0, Buffer.alloc(0)) },
  { name: "malformed-opus-too-long", frame: frame(Codec.opus16k, 0, Buffer.alloc(1276, 7)) },
  { name: "malformed-header-only", frame: Buffer.from([1, 0, 0]) },
].map(({ frame: f, ...rest }) => ({ ...rest, valid: isValidFrame(Buffer.concat([f, Buffer.alloc(FRAME_TAG_BYTES)])), hex: f.toString("hex") }));

const ack = { type: "hello-ack", clientTime: 1790726400000, serverTime: 1790726400042 };
const audio = Buffer.from(frames[0].hex, "hex");
const stream = Buffer.concat([encodeJSONRecord(ack), encodeRecord(RecordType.audio, audio)]);
const records = [
  { name: "json-hello-ack", type: "json", json: ack, hex: encodeJSONRecord(ack).toString("hex") },
  { name: "audio-opus", type: "audio", frame: "opus-apple-0", hex: encodeRecord(RecordType.audio, audio).toString("hex") },
  // The same two records split mid-header and mid-payload: a reader keeps the partial record.
  { name: "split-stream", chunks: [stream.subarray(0, 3), stream.subarray(3, 30), stream.subarray(30)].map((c) => c.toString("hex")), records: ["json-hello-ack", "audio-opus"] },
  { name: "malformed-type", hex: Buffer.from([9, 0, 0, 0, 1, 0]).toString("hex"), valid: false },
  { name: "malformed-too-long", hex: Buffer.from([2, 0, 1, 0, 1]).toString("hex"), valid: false },
];

writeFileSync(join(out, "frames.json"), JSON.stringify({ format: 1, description: "codec byte, uint32 big-endian sequence, one 20 ms payload", frames }, null, 2) + "\n");
writeFileSync(join(out, "records.json"), JSON.stringify({ description: "type byte (1 json, 2 audio), uint32 big-endian length (at most 65536), payload", records }, null, 2) + "\n");
console.log(`wrote ${frames.length} frames and ${records.length} records to ${out}`);
