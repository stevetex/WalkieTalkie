// Ring delivery through a push provider, behind one interface (contracts/README.md, "Devices
// and delivery"). Each provider's errors stay in its adapter; the relay sees only an outcome:
//
//   accepted             the provider took the ring. Not proof anyone heard it, or is online.
//   permanentlyRejected  the provider will never deliver to this token (it's removed, and the
//                        next device is tried).
//   unknownOrTransient   anything else. It may still ring, so no other device is rung for it.
//
// APNs is the only live provider. FCM comes in Phase 2 behind the same interface; until then
// FcmStub stands in for it on servers run for tests, and its rings are marked simulated so
// telemetry never counts them as delivered pushes.

import { missedAlert, prefetchAlert, pushToTalkRing, ringAlert, type PushResult, type Pusher } from "./apns.ts";
import type { Delivery } from "./contract.ts";
import type { RingPayload } from "./protocol.ts";

export type DeliveryOutcome = "accepted" | "permanentlyRejected" | "unknownOrTransient";

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  // For the relay's events, in the form telemetry.ts parses: "<kind>: status <n>[ reason] in <ms> ms[ (dry run)]".
  detail: string;
  // A stand-in (a dry run, or the FCM stub), not a real provider.
  simulated: boolean;
}

// What a ring is: the first push, the watch's second, silent push that prefetches the audio, or
// the notice that replaces the ring's notification once it ran out unanswered.
export type RingPush = "ring" | "prefetch" | "missed";

export interface PushDelivery {
  // Never throws.
  send(delivery: Delivery, ring: RingPayload, push: RingPush): Promise<DeliveryResult>;
  close(): void;
}

// APNs: alerts for watches, PushToTalk for iPhones.
export class ApnsDelivery implements PushDelivery {
  private pusher: Pusher;

  constructor(pusher: Pusher) {
    this.pusher = pusher;
  }

  async send(delivery: Delivery, ring: RingPayload, push: RingPush): Promise<DeliveryResult> {
    if (delivery.provider !== "apns") return unsupported(delivery);
    const body = push === "missed"
      ? missedAlert(ring, Date.now())
      : push === "prefetch" ? prefetchAlert(ring, ring.expiresAt) : delivery.mode === "pushtotalk" ? pushToTalkRing(ring) : ringAlert(ring, ring.expiresAt);
    const result = await this.pusher
      .sendAlert(delivery.token, delivery.environment, body)
      .catch((err: Error): PushResult => ({ ok: false, status: 0, reason: err.message, latencyMs: 0, dryRun: false }));
    const kind = push === "ring" ? delivery.mode : push;
    return {
      outcome: result.ok ? "accepted" : isUnreachable(result) ? "permanentlyRejected" : "unknownOrTransient",
      detail: `${kind}: status ${result.status}${result.reason ? ` ${result.reason}` : ""} in ${result.latencyMs.toFixed(0)} ms${result.dryRun ? " (dry run)" : ""}`,
      simulated: result.dryRun,
    };
  }

  close(): void {
    this.pusher.close();
  }
}

// APNs won't deliver to this token again (Apple's "Unregistered", or a token that isn't a
// device token for this app), as opposed to a failure that may be temporary.
export function isUnreachable(result: PushResult): boolean {
  if (result.ok || result.dryRun) return false;
  return result.status === 410 || (result.status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(result.reason ?? ""));
}

// Stands in for FCM until Phase 2: records what would be sent. A token starting "rejected:"
// is refused for good, and one starting "flaky:" fails transiently, so tests can drive both.
export class FcmStub implements PushDelivery {
  sent: Array<{ token: string; ring: RingPayload; push: RingPush }> = [];

  async send(delivery: Delivery, ring: RingPayload, push: RingPush): Promise<DeliveryResult> {
    if (delivery.provider !== "fcm") return unsupported(delivery);
    this.sent.push({ token: delivery.token, ring, push });
    const [outcome, status]: [DeliveryOutcome, number] = delivery.token.startsWith("rejected:")
      ? ["permanentlyRejected", 404]
      : delivery.token.startsWith("flaky:")
        ? ["unknownOrTransient", 503]
        : ["accepted", 200];
    return { outcome, detail: `fcm-${push === "ring" ? "notification" : push}: status ${status} in 0 ms (simulated)`, simulated: true };
  }

  close(): void {}
}

// The live providers, by name. Rings through a provider that isn't here can't be sent.
export class Deliveries implements PushDelivery {
  private providers: Partial<Record<Delivery["provider"], PushDelivery>>;

  constructor(providers: Partial<Record<Delivery["provider"], PushDelivery>>) {
    this.providers = providers;
  }

  has(provider: Delivery["provider"]): boolean {
    return this.providers[provider] !== undefined;
  }

  send(delivery: Delivery, ring: RingPayload, push: RingPush): Promise<DeliveryResult> {
    const provider = this.providers[delivery.provider];
    return provider ? provider.send(delivery, ring, push) : Promise.resolve(unsupported(delivery));
  }

  close(): void {
    for (const provider of Object.values(this.providers)) provider?.close();
  }
}

function unsupported(delivery: Delivery): DeliveryResult {
  return { outcome: "unknownOrTransient", detail: `${delivery.provider}: not available`, simulated: true };
}
