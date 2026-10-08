// Persistent identity for the Test Bot and local endpoint tools. Secret Manager supplies the
// production JSON; local runs keep a mode-0600 file under DATA_DIR. Never log this object.
import { randomBytes, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  agreementKey, issueDeviceCertificate, issueEncryptionKeyCertificate,
  issuePhoneCertificate, keyId, parseDeviceCertificate, parseEncryptionKeyCertificate,
  parsePhoneCertificate, rawPublic, signingKey, type SenderIdentity,
} from "./e2ee.ts";

export interface EndpointSecrets {
  userId: string;
  deviceId: string;
  clientKind: string;
  phoneSeed: string;
  deviceSeed: string;
  encSeed: string;
  phoneCert: string;
  deviceCert: string;
  encCert: string;
  previousEncSeed?: string;
  previousEncCert?: string;
  previousUntil?: number;
}

export interface EndpointKeys {
  secrets: EndpointSecrets;
  sender: SenderIdentity;
  encryption: Map<string, KeyObject>;
  registration: { phoneCert: string; deviceCert: string; encCert: string };
}

export function createEndpointSecrets(userId: string, deviceId: string, clientKind: string, now = Date.now()): EndpointSecrets {
  const phoneSeed = randomBytes(32);
  const deviceSeed = randomBytes(32);
  const encSeed = randomBytes(32);
  const identity = signingKey(phoneSeed);
  const device = signingKey(deviceSeed);
  return {
    userId, deviceId, clientKind,
    phoneSeed: phoneSeed.toString("base64"), deviceSeed: deviceSeed.toString("base64"), encSeed: encSeed.toString("base64"),
    phoneCert: issuePhoneCertificate(identity, userId, deviceId, now).toString("base64"),
    deviceCert: issueDeviceCertificate(identity, { userId, deviceId, clientKind, signingKey: rawPublic(device) }, now).toString("base64"),
    encCert: issueEncryptionKeyCertificate(device, { userId, deviceId, encKey: rawPublic(agreementKey(encSeed)) }, now).toString("base64"),
  };
}

export function openEndpointSecrets(secrets: EndpointSecrets, userId: string, deviceId: string, now = Date.now()): EndpointKeys {
  if (secrets.userId !== userId || secrets.deviceId !== deviceId) throw new Error("endpoint keys belong to another device");
  const seed = (value: string): Buffer => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== value) throw new Error("invalid endpoint key seed");
    return bytes;
  };
  const identity = signingKey(seed(secrets.phoneSeed));
  const device = signingKey(seed(secrets.deviceSeed));
  const encryption = agreementKey(seed(secrets.encSeed));
  const phoneCert = Buffer.from(secrets.phoneCert, "base64");
  const deviceCert = Buffer.from(secrets.deviceCert, "base64");
  const encCert = Buffer.from(secrets.encCert, "base64");
  const phone = parsePhoneCertificate(phoneCert);
  const signer = parseDeviceCertificate(deviceCert, phone);
  const enc = parseEncryptionKeyCertificate(encCert, signer);
  if (phone.userId !== userId || phone.deviceId !== deviceId || signer.deviceId !== deviceId ||
      signer.clientKind !== secrets.clientKind || !phone.identityKey.equals(rawPublic(identity)) ||
      !signer.signingKey.equals(rawPublic(device)) || !enc.encKey.equals(rawPublic(encryption)) || enc.notAfter <= now) {
    throw new Error("endpoint certificates don't match their keys or have expired");
  }
  const decryptKeys = new Map([[keyId(enc.encKey), encryption]]);
  if (secrets.previousEncSeed && secrets.previousEncCert && (secrets.previousUntil ?? 0) > now) {
    const previous = agreementKey(seed(secrets.previousEncSeed));
    const previousCert = parseEncryptionKeyCertificate(Buffer.from(secrets.previousEncCert, "base64"), signer);
    if (!previousCert.encKey.equals(rawPublic(previous))) throw new Error("previous endpoint key does not match its certificate");
    decryptKeys.set(previousCert.keyId, previous);
  }
  return {
    secrets,
    sender: { userId, deviceId, phoneCert, deviceCert, signingKey: device },
    encryption: decryptKeys,
    registration: { phoneCert: secrets.phoneCert, deviceCert: secrets.deviceCert, encCert: secrets.encCert },
  };
}

export function rotateEndpointSecrets(secrets: EndpointSecrets, now = Date.now()): EndpointSecrets {
  const phone = parsePhoneCertificate(Buffer.from(secrets.phoneCert, "base64"));
  const device = parseDeviceCertificate(Buffer.from(secrets.deviceCert, "base64"), phone);
  const enc = parseEncryptionKeyCertificate(Buffer.from(secrets.encCert, "base64"), device);
  const current = openEndpointSecrets(secrets, secrets.userId, secrets.deviceId, Math.min(now, enc.notAfter - 1));
  if (now - enc.issuedAt < 7 * 86_400_000) return secrets;
  const encSeed = randomBytes(32);
  const next = issueEncryptionKeyCertificate(current.sender.signingKey,
    { userId: secrets.userId, deviceId: secrets.deviceId, encKey: rawPublic(agreementKey(encSeed)) }, now);
  return { ...secrets, encSeed: encSeed.toString("base64"), encCert: next.toString("base64"),
    previousEncSeed: secrets.encSeed, previousEncCert: secrets.encCert, previousUntil: now + 7 * 86_400_000 };
}

export function localEndpointKeys(path: string, userId: string, deviceId: string, clientKind: string): EndpointKeys {
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(createEndpointSecrets(userId, deviceId, clientKind)), { mode: 0o600, flag: "wx" });
  const stored = JSON.parse(readFileSync(path, "utf8")) as EndpointSecrets;
  const rotated = rotateEndpointSecrets(stored);
  if (rotated !== stored) {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.new`;
    writeFileSync(temporary, JSON.stringify(rotated), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  return openEndpointSecrets(rotated, userId, deviceId);
}
