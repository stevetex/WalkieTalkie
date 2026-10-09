// The frozen v2 contract (contracts/README.md): every example against its schema, the binary
// fixtures against the relay's own parsers, and the requests the server must refuse against
// the server's validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SchemaSet } from "./json-schema.ts";
import { FRAME_TAG_BYTES, isValidFrame } from "../src/protocol.ts";
import { RecordParser } from "../src/records.ts";
import {
  E2EEError, FrameCipher, MAX_BUNDLE_AGE_MS, MAX_CLOCK_AHEAD_MS, agreementKey, fingerprint, hpkeOpen, keyId, openBundle,
  parseDeviceCertificate, parseEncryptionKeyCertificate, parsePhoneCertificate, rawPublic, signingKey, usableKeys,
} from "../src/e2ee.ts";

const contracts = join(import.meta.dirname!, "..", "..", "contracts");
const schemas = new SchemaSet(join(contracts, "schemas"));
const manifest = JSON.parse(readFileSync(join(contracts, "examples", "manifest.json"), "utf8")) as {
  examples: Array<{ file: string; schema: string; direction: "request" | "response"; many?: boolean; schemaValid?: boolean; serverError?: string }>;
};

export function example(file: string): unknown {
  return JSON.parse(readFileSync(join(contracts, "examples", file), "utf8"));
}

test("contracts: every schema's references resolve, and every example is listed", () => {
  for (const name of schemas.names) schemas.validate(name, {});
  const listed = new Set(manifest.examples.map((e) => e.file));
  for (const dir of ["current", "future", "rejected"]) {
    for (const file of readdirSafe(join(contracts, "examples", dir))) assert.ok(listed.has(`${dir}/${file}`), `${dir}/${file} isn't in manifest.json`);
  }
});

test("contracts: current and future examples follow their schemas; rejected ones as the manifest says", () => {
  for (const entry of manifest.examples) {
    const value = example(entry.file);
    const values = entry.many ? (value as unknown[]) : [value];
    for (const [i, v] of values.entries()) {
      const errors = schemas.validate(entry.schema, v);
      const where = `${entry.file}${entry.many ? `[${i}]` : ""}`;
      if (entry.file.startsWith("rejected/")) {
        assert.equal(errors.length === 0, entry.schemaValid === true, `${where}: schema says ${errors.join("; ") || "valid"}`);
      } else {
        assert.deepEqual(errors, [], `${where} against ${entry.schema}`);
      }
    }
  }
});

// frames.json holds frames as they are before sealing (format 2 keeps format 1's header and seals
// the payload), so each is checked as the relay sees it: with the 16-byte tag after it.
test("contracts: binary frames are accepted or dropped exactly as the fixtures say", () => {
  const { frames } = JSON.parse(readFileSync(join(contracts, "fixtures", "frames.json"), "utf8")) as {
    frames: Array<{ name: string; valid: boolean; hex: string; codec?: string; seq?: number; payloadBytes?: number }>;
  };
  assert.ok(frames.some((f) => f.codec === "opus16k" && f.valid) && frames.some((f) => f.codec === "pcm16le16k" && f.valid));
  for (const f of frames) {
    const frame = Buffer.from(f.hex, "hex");
    const sealed = Buffer.alloc(frame.length + FRAME_TAG_BYTES);
    frame.copy(sealed);
    assert.equal(isValidFrame(sealed), f.valid, f.name);
    if (!f.valid) continue;
    assert.equal(frame[0], f.codec === "opus16k" ? 1 : 2, f.name);
    assert.equal(frame.readUInt32BE(1), f.seq, f.name);
    assert.equal(frame.length - 5, f.payloadBytes, f.name);
  }
});

test("contracts: records parse whole, across chunk boundaries, and malformed ones are refused", () => {
  const { records } = JSON.parse(readFileSync(join(contracts, "fixtures", "records.json"), "utf8")) as {
    records: Array<{ name: string; type?: string; json?: unknown; hex?: string; chunks?: string[]; records?: string[]; valid?: boolean }>;
  };
  const byName = new Map(records.map((r) => [r.name, r]));
  for (const r of records) {
    if (r.chunks) {
      const parser = new RecordParser();
      const parsed = r.chunks.flatMap((c) => parser.push(Buffer.from(c, "hex")));
      assert.deepEqual(parsed.map((p) => (p.type === 1 ? "json" : "audio")), r.records!.map((n) => byName.get(n)!.type), r.name);
      continue;
    }
    const parser = new RecordParser();
    if (r.valid === false) {
      assert.throws(() => parser.push(Buffer.from(r.hex!, "hex")), r.name);
      continue;
    }
    const [record] = parser.push(Buffer.from(r.hex!, "hex"));
    assert.equal(record.type, r.type === "json" ? 1 : 2, r.name);
    if (r.json) assert.deepEqual(JSON.parse(record.payload.toString("utf8")), r.json, r.name);
  }
});

test("contracts: the end-to-end encryption vectors open, verify and refuse exactly as e2ee.json says", () => {
  const v = JSON.parse(readFileSync(join(contracts, "fixtures", "e2ee.json"), "utf8"));
  const hex = (s: string) => Buffer.from(s, "hex");
  const b64 = (s: string) => Buffer.from(s, "base64");

  assert.deepEqual(hpkeOpen(agreementKey(hex(v.hpke.skR)), hex(v.hpke.enc), hex(v.hpke.info), hex(v.hpke.aad), hex(v.hpke.ct)), hex(v.hpke.pt));
  assert.equal(v.limits.maxBundleAgeMs, MAX_BUNDLE_AGE_MS);
  assert.equal(v.limits.maxClockAheadMs, MAX_CLOCK_AHEAD_MS);

  const devices = new Map<string, { deviceId: string; encSecret: string; keyId: string }>();
  for (const account of v.accounts) {
    const phone = parsePhoneCertificate(b64(account.phoneCert));
    assert.equal(phone.userId, account.userId);
    assert.equal(phone.identityKey.toString("hex"), account.identityKey);
    assert.equal(rawPublic(signingKey(hex(account.identitySeed))).toString("hex"), account.identityKey);
    assert.equal(fingerprint(phone.identityKey), account.fingerprint);
    for (const d of account.devices) {
      const device = parseDeviceCertificate(b64(d.deviceCert), phone);
      assert.deepEqual([device.deviceId, device.clientKind], [d.deviceId, d.clientKind]);
      assert.deepEqual(device.signingKey, rawPublic(signingKey(hex(d.signingSeed))));
      const enc = parseEncryptionKeyCertificate(b64(d.encCert), device);
      assert.equal(enc.encKey.toString("hex"), d.encKey);
      assert.equal(enc.keyId, d.keyId);
      assert.equal(keyId(rawPublic(agreementKey(hex(d.encSecret)))), d.keyId);
      devices.set(d.name, d);
    }
  }

  const { recipients } = usableKeys(v.friendKeys.userId, v.friendKeys.keys, v.now);
  assert.deepEqual(recipients.map((r) => r.deviceId), v.friendKeys.usableDeviceIds);

  const m = v.message;
  for (const name of m.recipients) {
    const d = devices.get(name)!;
    const opened = openBundle(m.bundle, m.context, { deviceId: d.deviceId, keys: new Map([[d.keyId, agreementKey(hex(d.encSecret))]]) }, v.now);
    for (const f of m.frames) assert.deepEqual(opened.cipher.open(hex(f.frame)), { codec: 1, seq: f.seq, payload: hex(f.payload) }, `${name} frame ${f.seq}`);
    for (const f of v.badFrames) assert.throws(() => opened.cipher.open(hex(f.frame)), (e) => e instanceof E2EEError && e.failure === f.failure, f.name);
  }
  // The same message key gives the same frames.
  assert.equal(new FrameCipher(hex(m.messageKey), m.context.burstId).seal(1, 0, hex(m.frames[0].payload)).toString("hex"), m.frames[0].frame);

  for (const bad of v.bad) {
    const keys = new Map(Object.entries(bad.open.keys as Record<string, string>).map(([id, secret]) => [id, agreementKey(hex(secret))]));
    assert.throws(() => openBundle(bad.bundle, bad.context, { deviceId: bad.open.deviceId, keys }, bad.now), (e) => e instanceof E2EEError && e.failure === bad.failure, bad.name);
  }
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}
