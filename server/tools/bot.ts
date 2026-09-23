// Scripted participant for spike runs with a single watch.
//
//   node tools/bot.ts send --to <userId> [--say "text" | --wav file.wav] [--stay 45]
//       Rings <userId>, streams the audio in real time, then stays in the conversation
//       for --stay seconds so replies from the watch are heard (and counted).
//
//   node tools/bot.ts listen [--answer-delay 1500] [--stay 45]
//       Registers as a bot, waits to be rung, "answers" after the delay, and saves what it
//       hears. Use it to test the watch as the sender.
//
// Server and token come from SPIKE_SERVER (default http://localhost:8080) and SPIKE_TOKEN.

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpikeClient } from "./client.ts";
import { Codec, FRAME_HEADER_BYTES } from "../src/protocol.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string", default: "bot" },
    name: { type: "string", default: "Test Bot" },
    to: { type: "string" },
    say: { type: "string", default: "Hey, it's the test bot. Can you hear me? Over." },
    wav: { type: "string" },
    stay: { type: "string", default: "45" },
    "answer-delay": { type: "string", default: "1500" },
  },
});

const server = process.env.SPIKE_SERVER ?? "http://localhost:8080";
const token = process.env.SPIKE_TOKEN || undefined;
const mode = positionals[0];

const client = new SpikeClient({ server, userId: values.as!, token });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (mode === "send") {
  if (!values.to) throw new Error("--to <userId> is required");
  const pcm = values.wav ? readPcm16Mono16k(values.wav) : synthesize(values.say!);
  await client.register(values.name!);
  await client.connect();
  console.log(`Talking to ${values.to} for ${(pcm.length / 32000).toFixed(1)} s…`);
  const { conversationId, pushed } = await client.talk(values.to, pcm);
  console.log(pushed ? `Rang ${values.to} (conversation ${conversationId})` : `${values.to} was already live`);
  reportIncoming(client);
  await sleep(Number(values.stay) * 1000);
  client.send({ type: "leave", conversationId });
  await client.uploadMetrics(conversationId, "sender");
  client.close();
  console.log(`Done. Timeline: node tools/report.ts ${conversationId}`);
} else if (mode === "listen") {
  await client.register(values.name!);
  await client.connect();
  console.log(`Listening as ${client.userId}. Waiting for a ring…`);
  const ring = await client.waitFor("ring", () => true, 24 * 3600_000);
  client.mark("pushReceived", `from ${ring.fromName}`);
  client.mark("callReported");
  console.log(`Ring from ${ring.fromName}. Answering in ${values["answer-delay"]} ms…`);
  await sleep(Number(values["answer-delay"]));
  client.mark("answerTapped");
  client.mark("socketOpen", "bot keeps its socket open");
  client.send({ type: "join", conversationId: ring.conversationId });
  let firstAudio = true;
  client.onFrame = () => {
    if (firstAudio) {
      firstAudio = false;
      client.mark("firstAudioScheduled");
    }
  };
  reportIncoming(client);
  await sleep(Number(values.stay) * 1000);
  client.send({ type: "leave", conversationId: ring.conversationId });
  await client.uploadMetrics(ring.conversationId, "receiver");
  const pcmFrames = client.frames.filter((f) => f[0] === Codec.pcm16le16k);
  if (pcmFrames.length) {
    const path = join(tmpdir(), `walkie-${ring.conversationId}.wav`);
    writeFileSync(path, wav16k(Buffer.concat(pcmFrames.map((f) => f.subarray(FRAME_HEADER_BYTES)))));
    console.log(`Saved PCM audio to ${path}`);
  }
  client.close();
  console.log(`Done. Timeline: node tools/report.ts ${ring.conversationId}`);
} else {
  console.error("usage: node tools/bot.ts send --to <userId> | listen");
  process.exit(2);
}

function reportIncoming(c: SpikeClient): void {
  let frames = 0;
  c.onMessage = (m) => {
    if (m.type === "burst-start") {
      frames = 0;
      console.log(`← burst from ${m.from}${m.replay ? " (replayed from buffer)" : ""}`);
    } else if (m.type === "burst-end") {
      console.log(`← burst ended after ${frames} frames (${((frames * 20) / 1000).toFixed(1)} s)`);
    } else if (m.type === "peer-left") {
      console.log(`← ${m.peer} left the conversation`);
    } else if (m.type === "ring-timeout") {
      console.log(`← ${m.peer} didn't answer; ${m.droppedBursts} unheard burst(s) dropped`);
    }
  };
  const previous = c.onFrame;
  c.onFrame = (f) => {
    frames++;
    previous(f);
  };
}

// Uses macOS `say` to make 16 kHz mono PCM.
function synthesize(text: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "walkie-say-"));
  const path = join(dir, "say.wav");
  execFileSync("say", ["-o", path, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
  return readPcm16Mono16k(path);
}

function readPcm16Mono16k(path: string): Buffer {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let format: { channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) {
        throw new Error(`need 16 kHz mono 16-bit PCM, got ${JSON.stringify(format)}`);
      }
      return buf.subarray(body, body + size);
    }
    offset = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

function wav16k(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
