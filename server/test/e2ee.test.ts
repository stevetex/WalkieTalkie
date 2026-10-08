// End-to-end encryption helper (src/e2ee.ts): HPKE against RFC 9180, certificates, bundles and
// frames. The shared vectors in contracts/fixtures/e2ee.json are checked in contracts.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  E2EEError, FrameCipher, MAX_BUNDLE_AGE_MS, agreementKey, deriveAgreementKey, fingerprint, hpkeOpen, hpkeSeal,
  issueDeviceCertificate, issueEncryptionKeyCertificate, issuePhoneCertificate, keyId, openBundle, parseDeviceCertificate,
  parseEncryptionKeyCertificate, parsePhoneCertificate, rawPublic, sealBundle, signingKey, usableKeys,
} from "../src/e2ee.ts";

const h = (s: string) => Buffer.from(s, "hex");
const NOW = Date.UTC(2026, 9, 7);
const DAY = 86_400_000;

const failure = (f: () => unknown) => {
  try {
    f();
  } catch (error) {
    if (error instanceof E2EEError) return error.failure;
    throw error;
  }
  return "none";
};

test("e2ee: HPKE matches RFC 9180's base-mode vector for X25519, HKDF-SHA256 and ChaCha20-Poly1305", () => {
  const skE = deriveAgreementKey(h("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b"));
  const skR = deriveAgreementKey(h("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df"));
  assert.equal(rawPublic(skE).toString("hex"), "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
  assert.equal(rawPublic(skR).toString("hex"), "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a");
  const info = h("4f6465206f6e2061204772656369616e2055726e");
  const aad = h("436f756e742d30");
  const pt = h("4265617574792069732074727574682c20747275746820626561757479");
  const { enc, ct } = hpkeSeal(rawPublic(skR), info, aad, pt, skE);
  assert.equal(enc.toString("hex"), "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
  assert.equal(ct.toString("hex"), "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28");
  assert.deepEqual(hpkeOpen(skR, enc, info, aad, ct), pt);
  assert.equal(failure(() => hpkeOpen(skR, enc, info, h("00"), ct)), "decrypt");
});

// An account: a phone identity, and devices with signing and encryption keys.
function account(userId: string, kinds: string[]) {
  const identity = signingKey(randomBytes(32));
  const phoneCert = issuePhoneCertificate(identity, userId, `${userId}-0`, NOW - DAY);
  const devices = kinds.map((clientKind, i) => {
    const deviceId = `${userId}-${i}`;
    const sk = signingKey(randomBytes(32));
    const ek = agreementKey(randomBytes(32));
    const deviceCert = issueDeviceCertificate(identity, { userId, deviceId, clientKind, signingKey: rawPublic(sk) }, NOW - DAY);
    const encCert = issueEncryptionKeyCertificate(sk, { userId, deviceId, encKey: rawPublic(ek) }, NOW - DAY);
    return { deviceId, clientKind, sk, ek, deviceCert, encCert };
  });
  const keys = {
    phones: [phoneCert.toString("base64")],
    devices: devices.map((d) => ({ deviceId: d.deviceId, clientKind: d.clientKind, deviceCert: d.deviceCert.toString("base64"), encCert: d.encCert.toString("base64") })),
  };
  return { userId, identity, phoneCert, devices, keys };
}

test("e2ee: certificates chain from the phone to each device and its encryption key, and nothing else", () => {
  const alice = account("u_alice", ["ios", "watchos"]);
  const mallory = account("u_mallory", ["ios"]);
  const phone = parsePhoneCertificate(alice.phoneCert);
  assert.equal(phone.userId, "u_alice");
  assert.deepEqual(phone.identityKey, rawPublic(alice.identity));
  const watch = alice.devices[1]!;
  const device = parseDeviceCertificate(watch.deviceCert, phone);
  assert.equal(device.clientKind, "watchos");
  const enc = parseEncryptionKeyCertificate(watch.encCert, device);
  assert.equal(enc.keyId, keyId(rawPublic(watch.ek)));
  assert.equal(enc.notAfter - enc.issuedAt, 30 * DAY);

  // Another phone's certificate, another device's key, a certificate of the wrong kind, an altered byte.
  assert.equal(failure(() => parseDeviceCertificate(watch.deviceCert, parsePhoneCertificate(mallory.phoneCert))), "bad-certificate");
  assert.equal(failure(() => parseEncryptionKeyCertificate(alice.devices[0]!.encCert, device)), "bad-certificate");
  assert.equal(failure(() => parsePhoneCertificate(watch.deviceCert)), "bad-certificate");
  const altered = Buffer.from(alice.phoneCert);
  altered[20]! ^= 1;
  assert.equal(failure(() => parsePhoneCertificate(altered)), "bad-certificate");
  assert.equal(failure(() => parsePhoneCertificate(alice.phoneCert.subarray(0, 40))), "bad-certificate");

  assert.match(fingerprint(phone.identityKey), /^[\w-]{22}$/);
  assert.notEqual(fingerprint(phone.identityKey), fingerprint(rawPublic(mallory.identity)));
});

test("e2ee: a sender seals only to devices whose chain checks out and whose key hasn't expired", () => {
  const bob = account("u_bob", ["ios", "watchos", "watchos"]);
  const old = bob.devices[2]!;
  old.encCert = issueEncryptionKeyCertificate(old.sk, { userId: "u_bob", deviceId: old.deviceId, encKey: rawPublic(old.ek) }, NOW - 31 * DAY);
  bob.keys.devices[2]!.encCert = old.encCert.toString("base64");
  bob.keys.devices.push({ ...bob.keys.devices[1]!, deviceId: "u_bob-renamed" });
  const { phones, recipients } = usableKeys("u_bob", bob.keys, NOW);
  assert.equal(phones.length, 1);
  assert.deepEqual(recipients.map((r) => r.deviceId), ["u_bob-0", "u_bob-1"]);
  // Someone else's phone certificate in Bob's list is ignored.
  assert.deepEqual(usableKeys("u_carol", bob.keys, NOW).recipients, []);
});

test("e2ee: a bundle opens on each recipient device, and its frames decrypt; tampering is refused", () => {
  const alice = account("u_alice", ["ios", "watchos"]);
  const bob = account("u_bob", ["ios", "watchos"]);
  const watch = alice.devices[1]!;
  const sender = { userId: "u_alice", deviceId: watch.deviceId, phoneCert: alice.phoneCert, deviceCert: watch.deviceCert, signingKey: watch.sk };
  const context = { conversationId: "c1", burstId: "b1", codec: "opus16k", from: "u_alice", to: "u_bob" };
  const { recipients } = usableKeys("u_bob", bob.keys, NOW);
  const { bundle, cipher } = sealBundle(context, sender, recipients, NOW);
  const payload = randomBytes(60);
  const frame = cipher.seal(1, 7, payload);
  assert.equal(frame.length, 5 + 60 + 16);

  for (const device of bob.devices) {
    const me = { deviceId: device.deviceId, keys: new Map([[keyId(rawPublic(device.ek)), device.ek]]) };
    const opened = openBundle(bundle, context, me, NOW + 1000);
    assert.deepEqual(opened.senderIdentityKey, rawPublic(alice.identity));
    assert.equal(opened.senderDeviceId, watch.deviceId);
    assert.deepEqual(opened.cipher.open(frame), { codec: 1, seq: 7, payload });
  }

  const bobPhone = bob.devices[0]!;
  const me = { deviceId: bobPhone.deviceId, keys: new Map([[keyId(rawPublic(bobPhone.ek)), bobPhone.ek]]) };
  assert.equal(failure(() => openBundle(bundle, { ...context, burstId: "b2" }, me, NOW)), "bad-signature");
  assert.equal(failure(() => openBundle(bundle, { ...context, to: "u_carol" }, me, NOW)), "bad-signature");
  assert.equal(failure(() => openBundle(bundle, context, me, NOW + MAX_BUNDLE_AGE_MS + 1)), "too-old");
  assert.equal(failure(() => openBundle(bundle, context, { deviceId: "u_bob-9", keys: me.keys }, NOW)), "no-key");
  assert.equal(failure(() => openBundle({ ...bundle, v: 0 }, context, me, NOW)), "bad-bundle");
  assert.equal(failure(() => new FrameCipher(randomBytes(32), "b1").open(frame)), "decrypt");
  assert.equal(failure(() => cipher.open(frame.subarray(0, 20))), "decrypt");
});
