// Scripted participant for spike runs with a single watch.
//
//   node tools/bot.ts send --to <userId> [--say "text" | --wav file.wav] [--stay 45]
//                         [--ring-until-answered] [--again 20 [--say-again "text"]]
//       Rings <userId>, streams the audio in real time, then stays in the conversation
//       for --stay seconds so replies from the watch are heard (and counted).
//       --ring-until-answered rings again whenever a ring times out unanswered (for a
//       watch app that's closed until a notification opens it). --again sends a second
//       message that many seconds after the first (for testing with the wrist down).
//
//   Audio is Opus, as the apps send it (encoded by tools/opus-frames.swift with the system's
//   encoder, so macOS only); --pcm sends raw 16 kHz PCM instead, about 10× the bytes.
//
//   node tools/bot.ts listen [--answer-delay 1500] [--stay 45]
//       Registers as a bot, waits to be rung, "answers" after the delay, and saves what it
//       hears. Use it to test the watch as the sender.
//
// Server and token come from SPIKE_SERVER (default http://localhost:8080) and SPIKE_TOKEN.
//
// --account runs as the Test Bot's account (tools/test-account.ts create) instead of a
// shared-token user: it connects with the account's session token, can only ring its
// friends, and --to defaults to its first friend. SPIKE_TOKEN is then only used to read
// timelines (--ring-until-answered). Without --account the relay must run with
// SHARED_TOKEN_CLIENTS=1 (local only; relay nodes accept accounts only).

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpikeClient } from "./client.ts";
import { BOT_TOKEN_FILE, loadBotSession } from "./test-account.ts";
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
    "ring-until-answered": { type: "boolean", default: false },
    again: { type: "string" },
    "say-again": { type: "string", default: "This is the second message. Did it play with your wrist down? Over." },
    "answer-delay": { type: "string", default: "1500" },
    account: { type: "boolean", default: false },
    pcm: { type: "boolean", default: false },
  },
});

const server = process.env.SPIKE_SERVER ?? "http://localhost:8080";
const token = process.env.SPIKE_TOKEN || undefined;
const mode = positionals[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = values.account ? await accountClient() : new SpikeClient({ server, userId: values.as!, token });

// The Test Bot's account, with its token refreshed when it's within a day of expiring.
async function accountClient(): Promise<SpikeClient> {
  const session = loadBotSession();
  if (session.expiresAt - Date.now() < 24 * 3600_000) {
    const res = await fetch(new URL("/v1/auth/refresh", session.api), { method: "POST", headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new Error(`refreshing the bot's token: HTTP ${res.status}; run node tools/test-account.ts create`);
    Object.assign(session, await res.json());
    writeFileSync(BOT_TOKEN_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  }
  const accountBot = new SpikeClient({ server, userId: session.userId, token: session.token });
  if (!values.to && mode === "send") {
    const res = await fetch(new URL("/v1/friends", session.api), { headers: { authorization: `Bearer ${session.token}` } });
    const { friends } = (await res.json()) as { friends: Array<{ id: string; name: string }> };
    if (!friends?.length) throw new Error("the bot has no friends yet: node tools/test-account.ts accept <invite link>");
    values.to = friends[0].id;
    console.log(`Ringing the bot's friend ${friends[0].name}`);
  }
  return accountBot;
}

// Shared-token bots register a device; the bot's account registered one when it was created.
async function register(): Promise<void> {
  if (!values.account) await client.register(values.name!);
}

if (mode === "send") {
  if (!values.to) throw new Error("--to <userId> is required");
  const pcm = values.wav ? readPcm16Mono16k(values.wav) : synthesize(values.say!);
  await register();
  await client.connect();
  const audio = encode(pcm);
  console.log(`Talking to ${values.to} for ${(pcm.length / 32000).toFixed(1)} s (${audio.codec === Codec.opus16k ? "Opus" : "PCM"}, ${audio.frames.reduce((n, f) => n + f.length, 0)} bytes)…`);
  let { conversationId, pushed } = await client.talkFrames(values.to, audio);
  console.log(pushed ? `Rang ${values.to} (conversation ${conversationId})` : `${values.to} was already live`);
  reportIncoming(client);
  if (values["ring-until-answered"] && pushed) {
    // A ring for a closed app waits on the server until a notification opens the app, and
    // the relay abandons it after 35 s. Ring again after each timeout until the watch joins.
    for (let attempt = 2; attempt <= 10; ) {
      await sleep(1000);
      const events = await serverEvents(conversationId);
      if (events.includes("receiverJoined")) break;
      if (events.filter((e) => e === "ringTimedOut").length >= attempt - 1) {
        ({ conversationId } = await client.talkFrames(values.to, audio));
        console.log(`Rang again, attempt ${attempt}`);
        attempt++;
      }
    }
  }
  if (values.again) {
    await sleep(Number(values.again) * 1000);
    console.log(`Sending the second message…`);
    ({ conversationId } = await client.talkFrames(values.to, encode(synthesize(values["say-again"]!))));
  }
  await sleep(Number(values.stay) * 1000);
  client.send({ type: "leave", conversationId });
  await client.uploadMetrics(conversationId, "sender");
  client.close();
  console.log(`Done. Timeline: node tools/report.ts ${conversationId}`);
} else if (mode === "listen") {
  await register();
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

// Server-side event names in a conversation's timeline, oldest first.
async function serverEvents(conversationId: string): Promise<string[]> {
  const res = await fetch(new URL(`/v1/metrics/${conversationId}`, server), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return [];
  const { timeline } = (await res.json()) as { timeline: Array<{ source: string; name: string }> };
  return timeline.filter((e) => e.source === "server").map((e) => e.name);
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

// Opus packets from 16 kHz mono PCM16, as the apps encode it (tools/opus-frames.swift), or
// the PCM itself in 20 ms frames with --pcm.
function encode(pcm: Buffer): { codec: number; frames: Buffer[] } {
  if (values.pcm) {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += 640) frames.push(pcm.subarray(offset, offset + 640));
    return { codec: Codec.pcm16le16k, frames };
  }
  const dir = mkdtempSync(join(tmpdir(), "walkie-opus-"));
  writeFileSync(join(dir, "in.pcm"), pcm);
  execFileSync("swift", [join(import.meta.dirname, "opus-frames.swift"), join(dir, "in.pcm"), join(dir, "out.packets")], { stdio: ["ignore", "ignore", "inherit"] });
  const packed = readFileSync(join(dir, "out.packets"));
  const frames: Buffer[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const length = packed.readUInt16BE(offset);
    frames.push(packed.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return { codec: Codec.opus16k, frames };
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
