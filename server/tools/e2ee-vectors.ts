// Writes contracts/fixtures/e2ee.json: end-to-end encryption test vectors the server's tests
// (test/contracts.test.ts) and the kit's (ContractTests.swift) both check, so the apps and the
// Test Bot make and accept the same bytes. Everything is derived from fixed seeds, and Ed25519
// signatures are deterministic, so running it again writes the same file.
//
//   node tools/e2ee-vectors.ts
//
// Alice's watch sends Bob a message (three real Apple Opus frames from fixtures/frames.json),
// sealed to Bob's phone and watch. "bad" lists bundles and frames that must be refused, and
// why.

import { createHash, sign, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FrameCipher, MAX_BUNDLE_AGE_MS, MAX_CLOCK_AHEAD_MS, agreementKey, bundleSigningBytes, deriveAgreementKey, fingerprint, issueDeviceCertificate,
  issueEncryptionKeyCertificate, issuePhoneCertificate, keyId, rawPublic, sealBundle, signingKey, usableKeys,
  type BundleContext, type FriendKeysJSON, type KeyBundle,
} from "../src/e2ee.ts";

const contracts = join(import.meta.dirname!, "..", "..", "contracts");
const NOW = Date.UTC(2026, 9, 7, 18, 0, 0);
const DAY = 86_400_000;

const seed = (label: string) => createHash("sha256").update(`oao e2ee test vector: ${label}`).digest();
const hex = (b: Buffer) => b.toString("hex");
const b64 = (b: Buffer) => b.toString("base64");

interface Device {
  name: string;
  deviceId: string;
  clientKind: string;
  signingKey: KeyObject;
  encKey: KeyObject;
  deviceCert: Buffer;
  encCert: Buffer;
}

function account(name: string, userId: string, devices: Array<{ name: string; deviceId: string; clientKind: string }>) {
  const identity = signingKey(seed(`${name} identity`));
  const phoneDevice = devices[0]!;
  const phoneCert = issuePhoneCertificate(identity, userId, phoneDevice.deviceId, NOW - 20 * DAY);
  const made: Device[] = devices.map((d) => {
    const sk = signingKey(seed(`${d.name} signing`));
    const ek = agreementKey(seed(`${d.name} encryption`));
    const deviceCert = issueDeviceCertificate(identity, { userId, deviceId: d.deviceId, clientKind: d.clientKind, signingKey: rawPublic(sk) }, NOW - 20 * DAY);
    const encCert = issueEncryptionKeyCertificate(sk, { userId, deviceId: d.deviceId, encKey: rawPublic(ek) }, NOW - 3 * DAY);
    return { ...d, signingKey: sk, encKey: ek, deviceCert, encCert };
  });
  return { name, userId, identity, phoneCert, devices: made };
}

const alice = account("alice", "u_aliceAliceAlice1", [
  { name: "alice-phone", deviceId: "6c8f7e2a-1b3d-4e5f-9a7b-0c1d2e3f4a5b", clientKind: "ios" },
  { name: "alice-watch", deviceId: "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6", clientKind: "watchos" },
]);
const bob = account("bob", "u_bobBobBobBobBob1", [
  { name: "bob-phone", deviceId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", clientKind: "ios" },
  { name: "bob-watch", deviceId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9", clientKind: "watchos" },
]);
const mallory = account("mallory", "u_malloryMallory1", [{ name: "mallory-phone", deviceId: "7b6a5948-3726-4150-9f8e-7d6c5b4a3928", clientKind: "ios" }]);

const describe = (a: ReturnType<typeof account>) => ({
  name: a.name,
  userId: a.userId,
  identitySeed: hex(seed(`${a.name} identity`)),
  identityKey: hex(rawPublic(a.identity)),
  fingerprint: fingerprint(rawPublic(a.identity)),
  phoneCert: b64(a.phoneCert),
  devices: a.devices.map((d) => ({
    name: d.name,
    deviceId: d.deviceId,
    clientKind: d.clientKind,
    signingSeed: hex(seed(`${d.name} signing`)),
    encSecret: hex(seed(`${d.name} encryption`)),
    encKey: hex(rawPublic(d.encKey)),
    keyId: keyId(rawPublic(d.encKey)),
    deviceCert: b64(d.deviceCert),
    encCert: b64(d.encCert),
  })),
});

// Bob as the friends list shows him to Alice, plus two devices a sender must leave out: a watch
// whose encryption key expired yesterday, and a "watch" certified by Mallory's phone.
const bobOld = { deviceId: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901", sk: signingKey(seed("bob-old-watch signing")), ek: agreementKey(seed("bob-old-watch encryption")) };
const forged = { deviceId: "3c4d5e6f-7081-4293-a4b5-c6d7e8f90a1b", sk: signingKey(seed("forged-watch signing")), ek: agreementKey(seed("forged-watch encryption")) };
const bobKeys: FriendKeysJSON = {
  phones: [b64(bob.phoneCert)],
  devices: [
    ...bob.devices.map((d) => ({ deviceId: d.deviceId, clientKind: d.clientKind, deviceCert: b64(d.deviceCert), encCert: b64(d.encCert) })),
    {
      deviceId: bobOld.deviceId,
      clientKind: "watchos",
      deviceCert: b64(issueDeviceCertificate(bob.identity, { userId: bob.userId, deviceId: bobOld.deviceId, clientKind: "watchos", signingKey: rawPublic(bobOld.sk) }, NOW - 60 * DAY)),
      encCert: b64(issueEncryptionKeyCertificate(bobOld.sk, { userId: bob.userId, deviceId: bobOld.deviceId, encKey: rawPublic(bobOld.ek) }, NOW - 31 * DAY)),
    },
    {
      deviceId: forged.deviceId,
      clientKind: "watchos",
      deviceCert: b64(issueDeviceCertificate(mallory.identity, { userId: bob.userId, deviceId: forged.deviceId, clientKind: "watchos", signingKey: rawPublic(forged.sk) }, NOW - DAY)),
      encCert: b64(issueEncryptionKeyCertificate(forged.sk, { userId: bob.userId, deviceId: forged.deviceId, encKey: rawPublic(forged.ek) }, NOW - DAY)),
    },
  ],
};
const usable = usableKeys(bob.userId, bobKeys, NOW);

// The message: Alice's watch to Bob.
const sender = alice.devices[1]!;
const identity = { userId: alice.userId, deviceId: sender.deviceId, phoneCert: alice.phoneCert, deviceCert: sender.deviceCert, signingKey: sender.signingKey };
const context: BundleContext = {
  conversationId: "4f1c7f7e-9b1a-4f0b-9a55-1f6a0c3e2d11",
  burstId: "8b0c6c52-3d0f-4b8e-a1f4-0d9e0f1a2b3c",
  codec: "opus16k",
  from: alice.userId,
  to: bob.userId,
};
const sentAt = NOW - 5_000;
const messageKey = seed("message key");
const ephemerals = usable.recipients.map((r) => deriveAgreementKey(seed(`ephemeral ${r.deviceId}`)));
const { bundle, cipher } = sealBundle(context, identity, usable.recipients, sentAt, { messageKey, ephemerals });

const opus = (JSON.parse(readFileSync(join(contracts, "fixtures", "frames.json"), "utf8")).frames as Array<{ codec: string; valid: boolean; hex: string }>)
  .filter((f) => f.codec === "opus16k" && f.valid).slice(0, 3).map((f) => Buffer.from(f.hex, "hex").subarray(5));
const frames = opus.map((payload, seq) => ({ seq, codec: "opus16k", payload: hex(payload), frame: hex(cipher.seal(1, seq, payload)) }));

// Refused bundles. Each says which device opens it (its ID and its keys: key ID → secret),
// when, and the failure.
const clone = (b: KeyBundle): KeyBundle => JSON.parse(JSON.stringify(b));
const flip = (value: string, at = 0) => { const b = Buffer.from(value, "base64"); b[at]! ^= 1; return b64(b); };
const bobPhone = bob.devices[0]!;
const asBobPhone = { deviceId: bobPhone.deviceId, keys: { [keyId(rawPublic(bobPhone.encKey))]: hex(seed(`${bobPhone.name} encryption`)) } };
const bad: Array<Record<string, unknown>> = [];
const refuse = (name: string, failure: string, b: KeyBundle, extra: Record<string, unknown> = {}) =>
  bad.push({ name, failure, context, now: NOW, open: asBobPhone, bundle: b, ...extra });
const resign = (b: KeyBundle) => b64(sign(null, bundleSigningBytes(context, b.sentAt, b.sender.deviceId, b.keys), sender.signingKey));

{ const b = clone(bundle); b.sig = flip(b.sig); refuse("signature altered", "bad-signature", b); }
refuse("another burst", "bad-signature", bundle, { context: { ...context, burstId: "c0ffee00-0000-4000-8000-000000000001" } });
refuse("another conversation", "bad-signature", bundle, { context: { ...context, conversationId: "c0ffee00-0000-4000-8000-000000000002" } });
refuse("another codec", "bad-signature", bundle, { context: { ...context, codec: "pcm16le16k" } });
refuse("sent back to its sender", "bad-certificate", bundle, { context: { ...context, from: bob.userId, to: alice.userId } });
{ const b = clone(bundle); b.sentAt += 1; refuse("send time altered", "bad-signature", b); }
{ const b = clone(bundle); b.keys[0]!.ct = flip(b.keys[0]!.ct); refuse("sealed key altered", "bad-signature", b); }
refuse("too old", "too-old", bundle, { now: sentAt + MAX_BUNDLE_AGE_MS + 1 });
refuse("from the future", "from-the-future", bundle, { now: sentAt - MAX_CLOCK_AHEAD_MS - 1 });
refuse("not sealed to this device", "no-key", bundle, {
  open: { deviceId: bobOld.deviceId, keys: { [keyId(rawPublic(bobOld.ek))]: hex(seed("bob-old-watch encryption")) } },
});
refuse("this device's key isn't known", "no-key", bundle, { open: { deviceId: bobPhone.deviceId, keys: {} } });
{
  // Mallory's phone certifies a "watch" in Alice's name: the chain is broken.
  const fake = issueDeviceCertificate(mallory.identity, { userId: alice.userId, deviceId: sender.deviceId, clientKind: "watchos", signingKey: rawPublic(sender.signingKey) }, NOW - DAY);
  const b = clone(bundle);
  b.sender.deviceCert = b64(fake);
  refuse("device certificate from another phone", "bad-certificate", b);
}
{
  // Signed properly, but the sealed key won't open.
  const b = clone(bundle);
  b.keys[0]!.ct = flip(b.keys[0]!.ct, 5);
  b.sig = resign(b);
  refuse("sealed key altered and signed again", "decrypt", b);
}
{ const b = clone(bundle); b.v = 2; refuse("unknown version", "bad-bundle", b); }

const withByte = (b: Buffer, at: number, value: number) => { const c = Buffer.from(b); c[at] = value; return c; };
const flipLast = (b: Buffer) => { const c = Buffer.from(b); c[c.length - 1]! ^= 1; return c; };
const badFrames = [
  { name: "sequence number altered", failure: "decrypt", frame: hex(withByte(Buffer.from(frames[1]!.frame, "hex"), 4, 0)) },
  { name: "codec altered", failure: "decrypt", frame: hex(withByte(Buffer.from(frames[0]!.frame, "hex"), 0, 2)) },
  { name: "tag altered", failure: "decrypt", frame: hex(flipLast(Buffer.from(frames[2]!.frame, "hex"))) },
  { name: "from another burst", failure: "decrypt", frame: hex(new FrameCipher(messageKey, "c0ffee00-0000-4000-8000-000000000001").seal(1, 0, opus[0]!)) },
];

const out = {
  description: "End-to-end encryption test vectors (contracts/README.md, \"End-to-end encryption\"). Made by server/tools/e2ee-vectors.ts; don't edit by hand. Binary values are hex, certificates and bundle fields base64.",
  limits: { maxBundleAgeMs: MAX_BUNDLE_AGE_MS, maxClockAheadMs: MAX_CLOCK_AHEAD_MS },
  hpke: {
    source: "RFC 9180, A.2.1 and A.2.1.1 (sequence number 0): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base mode",
    skR: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
    pkR: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
    info: "4f6465206f6e2061204772656369616e2055726e",
    enc: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
    aad: "436f756e742d30",
    pt: "4265617574792069732074727574682c20747275746820626561757479",
    ct: "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28",
  },
  now: NOW,
  accounts: [describe(alice), describe(bob), describe(mallory)],
  friendKeys: { userId: bob.userId, keys: bobKeys, usableDeviceIds: usable.recipients.map((r) => r.deviceId) },
  message: {
    sender: sender.name,
    context,
    sentAt,
    messageKey: hex(messageKey),
    bundle,
    recipients: bob.devices.map((d) => d.name),
    frames,
  },
  bad,
  badFrames,
};

writeFileSync(join(contracts, "fixtures", "e2ee.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote contracts/fixtures/e2ee.json: ${bad.length} refused bundles, ${badFrames.length} refused frames.`);
