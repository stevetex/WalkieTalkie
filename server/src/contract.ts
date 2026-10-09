// The contract's vocabulary (contracts/README.md): client kinds and form factors, codecs,
// deliveries and capabilities. The API, the accounts and the relay all use these, so a value
// means the same thing everywhere.

import { Codec } from "./protocol.ts";

export const API_VERSIONS = [2] as const;
export const RELAY_PROTOCOLS = [2] as const;
// Binary audio formats the service carries: only format 2, end-to-end encrypted. Format 1
// (plaintext) was retired by E2EE_SPEC.md's PR D; builds that speak only it are told to update.
export const AUDIO_FORMATS = [2] as const;

// The build the service's own clients (the Canary, the bot and test tools) say they are. They
// speak the current contract, and admission compares builds with MINIMUM_BUILDS before it knows
// the account, so they must never fall below a minimum.
export const SERVICE_CLIENT_BUILD = "999999";

export const CLIENT_KINDS = ["ios", "watchos", "android", "wearos"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
export const FORM_FACTORS = ["phone", "watch"] as const;
export type FormFactor = (typeof FORM_FACTORS)[number];

export const CODECS = { opus16k: Codec.opus16k, pcm16le16k: Codec.pcm16le16k } as const;
export type CodecName = keyof typeof CODECS;
export const CODEC_NAMES = Object.keys(CODECS) as CodecName[];

export function isClientKind(value: unknown): value is ClientKind {
  return (CLIENT_KINDS as readonly unknown[]).includes(value);
}

export function isFormFactor(value: unknown): value is FormFactor {
  return (FORM_FACTORS as readonly unknown[]).includes(value);
}

export function isCodecName(value: unknown): value is CodecName {
  return typeof value === "string" && value in CODECS;
}

export function codecName(id: number): CodecName | undefined {
  return CODEC_NAMES.find((n) => CODECS[n] === id);
}

export function formFactorOf(kind: ClientKind): FormFactor {
  return kind === "ios" || kind === "android" ? "phone" : "watch";
}

// The watch kind a phone of this kind may make companion sessions for (same ecosystem only).
export function companionKindOf(kind: ClientKind): ClientKind | null {
  return kind === "ios" ? "watchos" : kind === "android" ? "wearos" : null;
}

// Which provider signs in which phone kind.
export function phoneKindFor(provider: SignInProvider): ClientKind {
  return provider === "apple" ? "ios" : "android";
}

export const SIGN_IN_PROVIDERS = ["apple", "google"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return (SIGN_IN_PROVIDERS as readonly unknown[]).includes(value);
}

// The telemetry label kept for dashboards: "watch" and "iphone" for Apple devices, Android
// kinds by their own names.
export function platformLabel(kind: ClientKind): string {
  return kind === "ios" ? "iphone" : kind === "watchos" ? "watch" : kind;
}

// ---- Deliveries ----

export type ApnsEnvironment = "sandbox" | "production";

// How a device is rung. Tokens never leave the server in answers.
export type Delivery =
  | { provider: "apns"; mode: "alert" | "pushtotalk"; token: string; environment: ApnsEnvironment }
  | { provider: "fcm"; mode: "notification"; token: string }
  // Rung only over this device's own open relay connection (an app on screen).
  | { provider: "relay"; mode: "foreground" }
  // Only on servers run for tests: any of the account's open relay connections (a bot's).
  | { provider: "test"; mode: "connection" };

export type ReceiveMode = "tap" | "automatic";
export type NotificationPermission = "authorized" | "denied" | "unknown";

export interface Availability {
  enabled: boolean;
  notifications: NotificationPermission;
}

export interface Capabilities {
  relayProtocols: number[];
  audioFormats: number[];
  decode: CodecName[];
  encode: CodecName[];
  features: string[];
}

// What a device that didn't say is assumed to support: every Apple build plays both codecs and
// sends Opus. Builds that didn't name their audio formats spoke only the retired format 1.
export const DEFAULT_CAPABILITIES: Capabilities = {
  relayProtocols: [2],
  audioFormats: [1],
  decode: ["opus16k", "pcm16le16k"],
  encode: ["opus16k"],
  features: [],
};

export function receiveModeOf(delivery: Delivery): ReceiveMode {
  return delivery.provider === "apns" && delivery.mode === "pushtotalk" ? "automatic" : "tap";
}

// A delivery only a notification can ring (so it's no use with notifications turned off).
export function isNotificationDelivery(delivery: Delivery): boolean {
  return (delivery.provider === "apns" && delivery.mode === "alert") || delivery.provider === "fcm";
}

// The token a delivery carries, if any.
export function deliveryToken(delivery: Delivery): string | undefined {
  return "token" in delivery ? delivery.token : undefined;
}

// The scope a push token is unique within: the same token text in another provider, topic or
// environment is a different registration.
export function tokenScope(delivery: Delivery): string | null {
  switch (delivery.provider) {
    case "apns": return `apns:${delivery.mode}:${delivery.environment}`;
    case "fcm": return "fcm";
    default: return null;
  }
}

export interface DeliveryPolicy {
  // FCM rings are enabled (Phase 2), or a stub stands in for them (tests).
  fcm: boolean;
  // Test deliveries may be registered (servers run for tests only).
  testDelivery: boolean;
}

export class ContractError extends Error {
  status: number;
  code: string;
  detail: Record<string, unknown>;
  constructor(status: number, code: string, message = code, detail: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// A v2 delivery as a client wrote it, checked strictly against what its kind may use.
export function parseDelivery(value: unknown, kind: ClientKind, policy: DeliveryPolicy): Delivery {
  if (!isObject(value)) throw new ContractError(400, "bad-request", "delivery is required");
  const { provider, mode, token, environment } = value;
  const unsupported = () => new ContractError(400, "unsupported-delivery", `${String(provider)}/${String(mode)} can't ring a ${kind} device`);
  const checkToken = (max: number): string => {
    if (typeof token !== "string" || !token || token.length > max || /\s/.test(token)) throw new ContractError(400, "bad-request", "delivery.token is required");
    return token;
  };
  switch (provider) {
    case "apns": {
      if (mode === "alert" && kind !== "watchos") throw unsupported();
      if (mode === "pushtotalk" && kind !== "ios") throw unsupported();
      if (mode !== "alert" && mode !== "pushtotalk") throw unsupported();
      if (environment !== undefined && environment !== "sandbox" && environment !== "production") throw new ContractError(400, "bad-request", "unknown APNs environment");
      return { provider, mode, token: checkToken(512), environment: environment === "production" ? "production" : "sandbox" };
    }
    case "fcm":
      if (mode !== "notification" || (kind !== "android" && kind !== "wearos")) throw unsupported();
      if (!policy.fcm) throw new ContractError(503, "provider-unavailable", "FCM delivery isn't enabled", { provider: "fcm" });
      return { provider, mode, token: checkToken(4096) };
    case "relay":
      if (mode !== "foreground") throw unsupported();
      return { provider, mode };
    case "test":
      if (!policy.testDelivery || mode !== "connection") throw unsupported();
      return { provider, mode };
    default:
      throw unsupported();
  }
}

export function parseAvailability(value: unknown): Availability {
  if (value === undefined) return { enabled: true, notifications: "unknown" };
  if (!isObject(value)) throw new ContractError(400, "bad-request", "availability must be an object");
  const { enabled, notifications } = value;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new ContractError(400, "bad-request", "availability.enabled must be a boolean");
  if (notifications !== undefined && !["authorized", "denied", "unknown"].includes(notifications as string)) {
    throw new ContractError(400, "bad-request", "unknown availability.notifications");
  }
  return { enabled: enabled !== false, notifications: (notifications as NotificationPermission | undefined) ?? "unknown" };
}

// What the device says it supports, intersected with what the service does. Unknown codecs and
// protocols are dropped (a newer client may know more); nothing in common is refused.
export function parseCapabilities(given: unknown): Capabilities {
  if (given !== undefined && !isObject(given)) throw new ContractError(400, "bad-request", "capabilities must be an object");
  // Unsaid capabilities are the defaults, which still have to be ones the service supports.
  const value = (given ?? {}) as Record<string, unknown>;
  const list = (v: unknown, name: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 64) throw new ContractError(400, "bad-request", `capabilities.${name} must be a short list`);
    return v;
  };
  const ints = (v: unknown, name: string, supported: readonly number[], fallback: number[]) => {
    const claimed = v === undefined ? fallback : list(v, name);
    return supported.filter((s) => claimed.includes(s));
  };
  const codecs = (v: unknown, name: string, fallback: CodecName[]) => {
    const given = list(v, name);
    return v === undefined ? fallback : CODEC_NAMES.filter((c) => given.includes(c));
  };
  const capabilities: Capabilities = {
    relayProtocols: ints(value.relayProtocols, "relayProtocols", RELAY_PROTOCOLS, [...DEFAULT_CAPABILITIES.relayProtocols]),
    audioFormats: ints(value.audioFormats, "audioFormats", AUDIO_FORMATS, [...DEFAULT_CAPABILITIES.audioFormats]),
    decode: codecs(value.decode, "decode", [...DEFAULT_CAPABILITIES.decode]),
    encode: codecs(value.encode, "encode", [...DEFAULT_CAPABILITIES.encode]),
    features: list(value.features, "features").filter((f): f is string => typeof f === "string" && f.length <= 64).slice(0, 64),
  };
  if (!capabilities.relayProtocols.length) throw new ContractError(409, "unsupported-protocol", "no relay protocol in common", { supported: { relayProtocols: [...RELAY_PROTOCOLS] } });
  if (!capabilities.audioFormats.length) throw upgradeRequired();
  if (!capabilities.decode.length) {
    throw new ContractError(409, "unsupported-codec", "no codec in common", { supported: { codecs: CODEC_NAMES } });
  }
  return capabilities;
}

// "opus16k,pcm16le16k" (the relay admission headers).
export function parseCodecList(header: string | undefined): CodecName[] | undefined {
  if (header === undefined) return undefined;
  const given = header.split(",").map((c) => c.trim());
  return CODEC_NAMES.filter((c) => given.includes(c));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- Relay admission ----

export type MinimumBuilds = Partial<Record<ClientKind, number>>;

// What a relay connection (or ring call) says about its client, from its headers.
export interface Admission {
  clientKind: ClientKind;
  build: string;
  clientVersion?: string;
  protocol: 2;
  decode: CodecName[];
  encode: CodecName[];
}

// A build that speaks no audio format the service still carries (format 1 only) must update.
function upgradeRequired(minimumBuild?: number): ContractError {
  return new ContractError(409, "client-upgrade-required", "Update Over&Out to keep talking.", minimumBuild === undefined ? {} : { minimumBuild });
}

// Checks a relay request's headers before it opens a stream or joins anything
// (contracts/README.md, "The relay"). Throws a ContractError to answer with.
export function parseAdmission(header: (name: string) => string | undefined, minimumBuilds: MinimumBuilds): Admission {
  const clientKind = header("x-oao-client-kind");
  if (!isClientKind(clientKind)) throw new ContractError(400, "bad-request", "X-OAO-Client-Kind is required");
  const build = header("x-oao-build");
  if (!build || !/^\d{1,12}$/.test(build)) throw new ContractError(400, "bad-request", "X-OAO-Build is required");
  const protocol = header("x-oao-relay-protocol");
  if (protocol === undefined || !(RELAY_PROTOCOLS as readonly number[]).includes(Number(protocol))) {
    throw new ContractError(409, "unsupported-protocol", `relay protocol ${protocol ?? "(none)"} isn't supported`, { supported: { relayProtocols: [...RELAY_PROTOCOLS] } });
  }
  const minimum = minimumBuilds[clientKind];
  if (minimum !== undefined && Number(build) < minimum) throw upgradeRequired(minimum);
  const decode = parseCodecList(header("x-oao-decode")) ?? [...DEFAULT_CAPABILITIES.decode];
  const claimedFormats = header("x-oao-audio-formats")?.split(",").map((f) => f.trim()) ?? [];
  if (!AUDIO_FORMATS.some((f) => claimedFormats.includes(String(f)))) throw upgradeRequired(minimum);
  if (!decode.length) throw new ContractError(409, "unsupported-codec", "no codec in common", { supported: { codecs: CODEC_NAMES } });
  const encode = parseCodecList(header("x-oao-encode")) ?? [...DEFAULT_CAPABILITIES.encode];
  const clientVersion = header("x-oao-client-version");
  return { clientKind, build, ...(clientVersion ? { clientVersion: clientVersion.slice(0, 32) } : {}), protocol: 2, decode, encode };
}

// MINIMUM_BUILDS: {"ios": 170, "watchos": 170}. Unknown kinds and non-numbers are refused, so a
// typo can't silently turn a minimum off.
export function parseMinimumBuilds(json: string | undefined): MinimumBuilds {
  if (!json) return {};
  const value = JSON.parse(json) as unknown;
  if (!isObject(value)) throw new Error("MINIMUM_BUILDS must be a JSON object of client kind to build number");
  const builds: MinimumBuilds = {};
  for (const [kind, build] of Object.entries(value)) {
    if (!isClientKind(kind) || !Number.isInteger(build) || (build as number) < 0) throw new Error(`MINIMUM_BUILDS: bad entry ${kind}`);
    builds[kind] = build as number;
  }
  return builds;
}
