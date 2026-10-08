// End-to-end encryption (E2EE_SPEC.md; contracts/README.md, "End-to-end encryption"): the
// certificates, the key bundle that opens a message, and binary audio format 2. The relay never
// needs any of this to forward a message; the Test Bot and the contract tests do. Everything is
// node:crypto, so the server stays free of dependencies: HPKE (RFC 9180, base mode,
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305) is built here from its primitives
// and checked against the RFC's test vectors (test/e2ee.test.ts).

import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, sign, verify, hkdfSync, type KeyObject } from "node:crypto";

export const AUDIO_FORMAT = 2;
export const BUNDLE_VERSION = 1;
// A listener plays a message only if its bundle was made at most this long ago by the
// listener's clock (the longest a real message waits: a 35 s ring, a 30 s join grace, up to 60 s
// of queued bursts and a 30 s resume, plus a minute for clock drift)…
export const MAX_BUNDLE_AGE_MS = 180_000;
// …and at most this far in the future (the sender's clock ahead of the listener's).
export const MAX_CLOCK_AHEAD_MS = 60_000;
// An encryption key's certificate is good for this long after it's issued.
export const ENC_CERT_LIFETIME_MS = 30 * 86_400_000;

const CONTEXT = {
  phone: "oao-phone-v1",
  device: "oao-device-v1",
  encKey: "oao-enckey-v1",
  bundle: "oao-bundle-v1",
  messageKey: "oao-message-key-v1",
  frames: "oao-frames-v1",
  fingerprint: "oao-fingerprint-v1",
} as const;

const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const TAG_BYTES = 16;

// Why a bundle or frame was refused. The apps use the same names (E2EE.Failure).
export type E2EEFailure = "bad-bundle" | "bad-certificate" | "bad-signature" | "too-old" | "from-the-future" | "no-key" | "decrypt";

export class E2EEError extends Error {
  readonly failure: E2EEFailure;
  constructor(failure: E2EEFailure, message?: string) {
    super(message ?? failure);
    this.failure = failure;
  }
}

// MARK: Byte strings

// Signed and sealed bytes are built from these, never from JSON: a context string, then
// length-prefixed fields, so every platform signs and checks the same bytes.
export class Writer {
  private parts: Buffer[] = [];
  str(value: string): this { return this.bytes(Buffer.from(value, "utf8")); }
  bytes(value: Uint8Array): this {
    if (value.length > 0xffff) throw new Error("field too long");
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    this.parts.push(length, Buffer.from(value));
    return this;
  }
  u8(value: number): this { this.parts.push(Buffer.from([value])); return this; }
  u16(value: number): this { const b = Buffer.alloc(2); b.writeUInt16BE(value); this.parts.push(b); return this; }
  u64(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("bad u64");
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(value));
    this.parts.push(b);
    return this;
  }
  done(): Buffer { return Buffer.concat(this.parts); }
}

export class Reader {
  private offset = 0;
  private readonly data: Buffer;
  constructor(data: Buffer) { this.data = data; }
  private take(count: number): Buffer {
    if (this.offset + count > this.data.length) throw new E2EEError("bad-certificate", "truncated");
    const out = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }
  bytes(): Buffer { return this.take(this.take(2).readUInt16BE()); }
  key(): Buffer {
    const key = this.bytes();
    if (key.length !== KEY_BYTES) throw new E2EEError("bad-certificate", "bad key length");
    return key;
  }
  str(): string { return this.bytes().toString("utf8"); }
  u64(): number {
    const value = this.take(8).readBigUInt64BE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new E2EEError("bad-certificate", "time out of range");
    return Number(value);
  }
  get position(): number { return this.offset; }
  get remaining(): number { return this.data.length - this.offset; }
}

// MARK: Keys

// Raw 32-byte keys in and out of node:crypto's KeyObjects (PKCS#8 and SPKI with the fixed
// prefixes for Ed25519 and X25519).
const PREFIX = {
  ed25519Private: Buffer.from("302e020100300506032b657004220420", "hex"),
  ed25519Public: Buffer.from("302a300506032b6570032100", "hex"),
  x25519Private: Buffer.from("302e020100300506032b656e04220420", "hex"),
  x25519Public: Buffer.from("302a300506032b656e032100", "hex"),
};

export function signingKey(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PREFIX.ed25519Private, seed]), format: "der", type: "pkcs8" });
}

export function agreementKey(secret: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PREFIX.x25519Private, secret]), format: "der", type: "pkcs8" });
}

function ed25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([PREFIX.ed25519Public, raw]), format: "der", type: "spki" });
}

function x25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([PREFIX.x25519Public, raw]), format: "der", type: "spki" });
}

// The raw public key of an Ed25519 or X25519 private key.
export function rawPublic(key: KeyObject): Buffer {
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-KEY_BYTES);
}

function signBytes(key: KeyObject, data: Buffer): Buffer {
  return sign(null, data, key);
}

function verifyBytes(publicKey: Uint8Array, data: Buffer, signature: Uint8Array): boolean {
  if (publicKey.length !== KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    return verify(null, data, ed25519Public(publicKey), signature);
  } catch {
    return false;
  }
}

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

// An encryption key's ID: the first 8 bytes of its SHA-256, in hex.
export function keyId(encKey: Uint8Array): string {
  return sha256(encKey).subarray(0, 8).toString("hex");
}

// What people compare: the first 16 bytes of SHA-256 over the context and a phone identity
// key, base64url without padding (22 characters). It goes in invite links' fragments.
export function fingerprint(identityKey: Uint8Array): string {
  return sha256(new Writer().str(CONTEXT.fingerprint).done(), identityKey).subarray(0, 16).toString("base64url");
}

// MARK: Certificates

// Each certificate is its signed body (a context string and fields) followed by a 64-byte
// Ed25519 signature over the body.
export interface PhoneCertificate { userId: string; deviceId: string; identityKey: Buffer; issuedAt: number; raw: Buffer }
export interface DeviceCertificate { userId: string; deviceId: string; clientKind: string; signingKey: Buffer; issuerKey: Buffer; issuedAt: number; raw: Buffer }
export interface EncryptionKeyCertificate { userId: string; deviceId: string; encKey: Buffer; keyId: string; issuedAt: number; notAfter: number; raw: Buffer }

function signed(body: Buffer, key: KeyObject): Buffer {
  return Buffer.concat([body, signBytes(key, body)]);
}

// Splits a certificate into its body's reader and checks the context; the caller reads the
// fields, then `finish` checks nothing is left over and the signature.
function open(raw: Buffer, context: string): { reader: Reader; finish: (key: Uint8Array) => void } {
  if (raw.length <= SIGNATURE_BYTES) throw new E2EEError("bad-certificate", "too short");
  const body = raw.subarray(0, raw.length - SIGNATURE_BYTES);
  const signature = raw.subarray(raw.length - SIGNATURE_BYTES);
  const reader = new Reader(body);
  if (reader.str() !== context) throw new E2EEError("bad-certificate", "wrong kind");
  return {
    reader,
    finish(key) {
      if (reader.remaining !== 0) throw new E2EEError("bad-certificate", "trailing bytes");
      if (!verifyBytes(key, body, signature)) throw new E2EEError("bad-certificate", "bad signature");
    },
  };
}

export function issuePhoneCertificate(identity: KeyObject, userId: string, deviceId: string, issuedAt: number): Buffer {
  const body = new Writer().str(CONTEXT.phone).str(userId).str(deviceId).bytes(rawPublic(identity)).u64(issuedAt).done();
  return signed(body, identity);
}

// Self-signed: checks the signature with the key it carries.
export function parsePhoneCertificate(raw: Buffer): PhoneCertificate {
  const { reader, finish } = open(raw, CONTEXT.phone);
  const cert = { userId: reader.str(), deviceId: reader.str(), identityKey: reader.key(), issuedAt: reader.u64(), raw };
  finish(cert.identityKey);
  return cert;
}

export function issueDeviceCertificate(
  identity: KeyObject,
  device: { userId: string; deviceId: string; clientKind: string; signingKey: Uint8Array },
  issuedAt: number,
): Buffer {
  const body = new Writer().str(CONTEXT.device).str(device.userId).str(device.deviceId).str(device.clientKind)
    .bytes(device.signingKey).bytes(rawPublic(identity)).u64(issuedAt).done();
  return signed(body, identity);
}

// Checks it was issued by `phone`, for the same account.
export function parseDeviceCertificate(raw: Buffer, phone: PhoneCertificate): DeviceCertificate {
  const { reader, finish } = open(raw, CONTEXT.device);
  const cert = { userId: reader.str(), deviceId: reader.str(), clientKind: reader.str(), signingKey: reader.key(), issuerKey: reader.key(), issuedAt: reader.u64(), raw };
  if (!cert.issuerKey.equals(phone.identityKey)) throw new E2EEError("bad-certificate", "another phone's");
  if (cert.userId !== phone.userId) throw new E2EEError("bad-certificate", "another account's");
  finish(phone.identityKey);
  return cert;
}

export function issueEncryptionKeyCertificate(
  deviceSigningKey: KeyObject,
  key: { userId: string; deviceId: string; encKey: Uint8Array },
  issuedAt: number,
  notAfter = issuedAt + ENC_CERT_LIFETIME_MS,
): Buffer {
  const body = new Writer().str(CONTEXT.encKey).str(key.userId).str(key.deviceId).bytes(key.encKey).u64(issuedAt).u64(notAfter).done();
  return signed(body, deviceSigningKey);
}

// Checks it was signed by `device`'s signing key, for the same account and device.
export function parseEncryptionKeyCertificate(raw: Buffer, device: DeviceCertificate): EncryptionKeyCertificate {
  const { reader, finish } = open(raw, CONTEXT.encKey);
  const userId = reader.str();
  const deviceId = reader.str();
  const encKey = reader.key();
  const cert = { userId, deviceId, encKey, keyId: keyId(encKey), issuedAt: reader.u64(), notAfter: reader.u64(), raw };
  if (cert.userId !== device.userId || cert.deviceId !== device.deviceId) throw new E2EEError("bad-certificate", "another device's");
  finish(device.signingKey);
  return cert;
}

// MARK: A friend's keys (the friends list, and a keys-stale refusal)

export interface FriendKeysJSON {
  phones: string[];
  devices: Array<{ deviceId: string; clientKind: string; deviceCert: string; encCert: string }>;
  /** False while a registered device still has no certified encryption key. */
  allDevicesHaveKeys?: boolean;
}

export interface RecipientKey { deviceId: string; keyId: string; encKey: Buffer; notAfter: number }

// What a sender can seal to: every device whose chain checks out (its certificate from one of
// the account's phones, its encryption key from the device) and whose key hasn't expired.
// Anything that doesn't check out is left out, not an error: one bad device mustn't stop a
// message to the others.
export function usableKeys(userId: string, keys: FriendKeysJSON, now: number): { phones: PhoneCertificate[]; recipients: RecipientKey[] } {
  const phones: PhoneCertificate[] = [];
  for (const raw of keys.phones) {
    try {
      const phone = parsePhoneCertificate(Buffer.from(raw, "base64"));
      if (phone.userId === userId) phones.push(phone);
    } catch { /* left out */ }
  }
  const recipients: RecipientKey[] = [];
  for (const device of keys.devices) {
    for (const phone of phones) {
      try {
        const cert = parseDeviceCertificate(Buffer.from(device.deviceCert, "base64"), phone);
        if (cert.deviceId !== device.deviceId) break;
        const enc = parseEncryptionKeyCertificate(Buffer.from(device.encCert, "base64"), cert);
        if (enc.notAfter > now) recipients.push({ deviceId: device.deviceId, keyId: enc.keyId, encKey: enc.encKey, notAfter: enc.notAfter });
        break;
      } catch { /* try the account's other phones */ }
    }
  }
  return { phones, recipients };
}

// MARK: HPKE (RFC 9180): base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305

const I2OSP = (value: number, length: number) => { const b = Buffer.alloc(length); b.writeUIntBE(value, 0, length); return b; };
const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), I2OSP(0x0020, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from("HPKE"), I2OSP(0x0020, 2), I2OSP(0x0001, 2), I2OSP(0x0003, 2)]);
const HPKE_V1 = Buffer.from("HPKE-v1");

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = createHmac("sha256", prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
  hkdfExtract(salt, Buffer.concat([HPKE_V1, suite, Buffer.from(label), ikm]));
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) =>
  hkdfExpand(prk, Buffer.concat([I2OSP(length, 2), HPKE_V1, suite, Buffer.from(label), info]), length);

// DeriveKeyPair for X25519: a deterministic key from input keying material (tests and vectors).
export function deriveAgreementKey(ikm: Buffer): KeyObject {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "dkp_prk", ikm);
  return agreementKey(labeledExpand(KEM_SUITE, prk, "sk", Buffer.alloc(0), KEY_BYTES));
}

function sharedSecret(dh: Buffer, enc: Buffer, pkR: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", Buffer.concat([enc, pkR]), 32);
}

function keySchedule(shared: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const empty = Buffer.alloc(0);
  const context = Buffer.concat([
    Buffer.from([0]),
    labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty),
    labeledExtract(HPKE_SUITE, empty, "info_hash", info),
  ]);
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", empty);
  return { key: labeledExpand(HPKE_SUITE, secret, "key", context, 32), nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12) };
}

function chachaSeal(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function chachaOpen(key: Buffer, nonce: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new E2EEError("decrypt");
  try {
    const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad, { plaintextLength: sealed.length - TAG_BYTES });
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new E2EEError("decrypt");
  }
}

// Single-shot seal (the first message of a context). `ephemeral` is for test vectors only.
export function hpkeSeal(pkR: Buffer, info: Buffer, aad: Buffer, plaintext: Buffer, ephemeral?: KeyObject): { enc: Buffer; ct: Buffer } {
  const skE = ephemeral ?? agreementKey(randomBytes(KEY_BYTES));
  const enc = rawPublic(skE);
  const dh = diffieHellman({ privateKey: skE, publicKey: x25519Public(pkR) });
  const { key, nonce } = keySchedule(sharedSecret(dh, enc, pkR), info);
  return { enc, ct: chachaSeal(key, nonce, aad, plaintext) };
}

export function hpkeOpen(skR: KeyObject, enc: Buffer, info: Buffer, aad: Buffer, ct: Buffer): Buffer {
  if (enc.length !== KEY_BYTES) throw new E2EEError("decrypt");
  let dh: Buffer;
  try {
    dh = diffieHellman({ privateKey: skR, publicKey: x25519Public(enc) });
  } catch {
    throw new E2EEError("decrypt");
  }
  const { key, nonce } = keySchedule(sharedSecret(dh, enc, rawPublic(skR)), info);
  return chachaOpen(key, nonce, aad, ct);
}

// MARK: The key bundle

export interface KeyBundle {
  v: number;
  sender: { deviceId: string; phoneCert: string; deviceCert: string };
  keys: Array<{ deviceId: string; keyId: string; enc: string; ct: string }>;
  sentAt: number;
  sig: string;
}

export interface BundleContext {
  conversationId: string;
  burstId: string;
  codec: string;
  from: string; // the sender's account
  to: string; // the listener's account
}

export interface SenderIdentity {
  userId: string;
  deviceId: string;
  phoneCert: Buffer;
  deviceCert: Buffer;
  signingKey: KeyObject;
}

function messageKeyInfo(burstId: string, deviceId: string, id: string): Buffer {
  return new Writer().str(CONTEXT.messageKey).str(burstId).str(deviceId).str(id).done();
}

// The bytes a bundle's signature covers.
export function bundleSigningBytes(context: BundleContext, sentAt: number, senderDeviceId: string, keys: KeyBundle["keys"]): Buffer {
  const writer = new Writer().str(CONTEXT.bundle).str(context.conversationId).str(context.burstId).u8(AUDIO_FORMAT)
    .str(context.codec).u64(sentAt).str(context.from).str(senderDeviceId).str(context.to).u16(keys.length);
  for (const key of keys) {
    writer.str(key.deviceId).str(key.keyId).bytes(Buffer.from(key.enc, "base64")).bytes(Buffer.from(key.ct, "base64"));
  }
  return writer.done();
}

// Seals a new message key to each recipient device and signs the bundle. `messageKey` and
// `ephemerals` (one per recipient) are for test vectors only.
export function sealBundle(
  context: BundleContext,
  sender: SenderIdentity,
  recipients: RecipientKey[],
  sentAt: number,
  testing?: { messageKey: Buffer; ephemerals: KeyObject[] },
): { bundle: KeyBundle; cipher: FrameCipher } {
  if (sender.userId !== context.from) throw new Error("sender isn't the bundle's sender");
  const messageKey = testing?.messageKey ?? randomBytes(KEY_BYTES);
  const keys = recipients.map((recipient, i) => {
    const { enc, ct } = hpkeSeal(recipient.encKey, messageKeyInfo(context.burstId, recipient.deviceId, recipient.keyId), Buffer.alloc(0), messageKey, testing?.ephemerals[i]);
    return { deviceId: recipient.deviceId, keyId: recipient.keyId, enc: enc.toString("base64"), ct: ct.toString("base64") };
  });
  const sig = signBytes(sender.signingKey, bundleSigningBytes(context, sentAt, sender.deviceId, keys));
  return {
    bundle: {
      v: BUNDLE_VERSION,
      sender: { deviceId: sender.deviceId, phoneCert: sender.phoneCert.toString("base64"), deviceCert: sender.deviceCert.toString("base64") },
      keys,
      sentAt,
      sig: sig.toString("base64"),
    },
    cipher: new FrameCipher(messageKey, context.burstId),
  };
}

export interface OpenedBundle {
  // The sender's phone identity key, which the listener compares with the keys it has seen
  // for this friend (a new one is the "security code changed" notice).
  senderIdentityKey: Buffer;
  senderDeviceId: string;
  cipher: FrameCipher;
}

// Checks a bundle for this device and opens its message key. `myKeys` maps this device's key
// IDs (current and previous) to their private keys.
export function openBundle(
  bundle: KeyBundle,
  context: BundleContext,
  me: { deviceId: string; keys: Map<string, KeyObject> },
  now: number,
): OpenedBundle {
  if (bundle?.v !== BUNDLE_VERSION || typeof bundle.sender !== "object" || !Array.isArray(bundle.keys) || !Number.isSafeInteger(bundle.sentAt)) {
    throw new E2EEError("bad-bundle");
  }
  const phone = parsePhoneCertificate(Buffer.from(bundle.sender.phoneCert, "base64"));
  if (phone.userId !== context.from) throw new E2EEError("bad-certificate", "another account's phone");
  const device = parseDeviceCertificate(Buffer.from(bundle.sender.deviceCert, "base64"), phone);
  if (device.deviceId !== bundle.sender.deviceId) throw new E2EEError("bad-certificate", "another device's");
  if (!verifyBytes(device.signingKey, bundleSigningBytes(context, bundle.sentAt, bundle.sender.deviceId, bundle.keys), Buffer.from(bundle.sig, "base64"))) {
    throw new E2EEError("bad-signature");
  }
  if (now - bundle.sentAt > MAX_BUNDLE_AGE_MS) throw new E2EEError("too-old");
  if (bundle.sentAt - now > MAX_CLOCK_AHEAD_MS) throw new E2EEError("from-the-future");
  const entry = bundle.keys.find((k) => k.deviceId === me.deviceId);
  const key = entry && me.keys.get(entry.keyId);
  if (!entry || !key) throw new E2EEError("no-key");
  const messageKey = hpkeOpen(key, Buffer.from(entry.enc, "base64"), messageKeyInfo(context.burstId, me.deviceId, entry.keyId), Buffer.alloc(0), Buffer.from(entry.ct, "base64"));
  if (messageKey.length !== KEY_BYTES) throw new E2EEError("decrypt");
  return { senderIdentityKey: phone.identityKey, senderDeviceId: device.deviceId, cipher: new FrameCipher(messageKey, context.burstId) };
}

// MARK: Frames (binary audio format 2)

//   byte 0      codec (as format 1)
//   bytes 1..4  sequence number, uint32 big-endian (as format 1)
//   bytes 5..   ChaCha20-Poly1305 of the payload, then its 16-byte tag
// Key: HKDF-SHA256 of the message key (no salt, info "oao-frames-v1"). Nonce: 8 zero bytes and
// the sequence number. Additional data: the format (2), the codec, the sequence number and the
// burst ID, so a frame can't be moved to another place or burst.
export class FrameCipher {
  private readonly key: Buffer;
  private readonly burstId: string;

  constructor(messageKey: Buffer, burstId: string) {
    this.key = Buffer.from(hkdfSync("sha256", messageKey, Buffer.alloc(0), Buffer.from(CONTEXT.frames), KEY_BYTES));
    this.burstId = burstId;
  }

  private nonceAndAAD(codec: number, seq: number): { nonce: Buffer; aad: Buffer } {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(seq, 8);
    const header = Buffer.alloc(6);
    header[0] = AUDIO_FORMAT;
    header[1] = codec;
    header.writeUInt32BE(seq, 2);
    return { nonce, aad: Buffer.concat([header, Buffer.from(this.burstId, "utf8")]) };
  }

  seal(codec: number, seq: number, payload: Buffer): Buffer {
    const { nonce, aad } = this.nonceAndAAD(codec, seq);
    const header = Buffer.alloc(5);
    header[0] = codec;
    header.writeUInt32BE(seq, 1);
    return Buffer.concat([header, chachaSeal(this.key, nonce, aad, payload)]);
  }

  open(frame: Buffer): { codec: number; seq: number; payload: Buffer } {
    if (frame.length < 5 + TAG_BYTES) throw new E2EEError("decrypt");
    const codec = frame[0]!;
    const seq = frame.readUInt32BE(1);
    const { nonce, aad } = this.nonceAndAAD(codec, seq);
    return { codec, seq, payload: chachaOpen(this.key, nonce, aad, frame.subarray(5)) };
  }
}
