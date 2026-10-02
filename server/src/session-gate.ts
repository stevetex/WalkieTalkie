// The relay's session checks (contracts/README.md, "Identity and sessions"). A session token is
// signed, so the relay could trust it until it expires; but signing out, signing in again, a
// phone revoking its watch and deleting the account must stop the relay too. So relay
// admission checks the stored session, and an open connection is checked again at least every
// `ttlMs`. Checks are cached per session for `ttlMs`, and concurrent ones share one lookup.
//
// Admission fails closed: if the lookup fails, the connection is refused (503). An open
// connection survives a failed lookup (an outage isn't a sign-out) and is checked again later.

import type { SessionRecord } from "./accounts.ts";
import type { SessionClaims } from "./session.ts";

export interface SessionLookup {
  activeSession(userId: string, sid: string, deviceId: string): Promise<SessionRecord | null>;
}

interface Entry {
  record: SessionRecord | null;
  at: number;
}

export class SessionGate {
  private lookup: SessionLookup;
  private ttlMs: number;
  private now: () => number;
  private cache = new Map<string, Entry>();
  private inFlight = new Map<string, Promise<SessionRecord | null>>();

  constructor(lookup: SessionLookup, options: { ttlMs?: number; now?: () => number } = {}) {
    this.lookup = lookup;
    this.ttlMs = options.ttlMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get checkIntervalMs(): number {
    return this.ttlMs;
  }

  // The session for a new connection or request, from a check at most ttlMs old. Null if it
  // has ended; throws if it couldn't be checked.
  async admit(claims: SessionClaims): Promise<SessionRecord | null> {
    const key = keyOf(claims);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.record;
    return this.check(key, claims);
  }

  // For an open connection: false only once the session is known to have ended.
  async stillActive(claims: SessionClaims): Promise<boolean> {
    try {
      return (await this.admit(claims)) !== null;
    } catch {
      return true;
    }
  }

  // Forgets what's known about a session (tests, and a sign-out seen by this process).
  forget(claims: SessionClaims): void {
    this.cache.delete(keyOf(claims));
  }

  private check(key: string, claims: SessionClaims): Promise<SessionRecord | null> {
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.lookup
        .activeSession(claims.sub, claims.sid, claims.dev)
        .then((record) => {
          this.cache.set(key, { record, at: this.now() });
          if (this.cache.size > 50_000) this.prune();
          return record;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.cache) if (entry.at < cutoff) this.cache.delete(key);
  }
}

function keyOf(claims: SessionClaims): string {
  return `${claims.sub}\n${claims.dev}\n${claims.sid}`;
}
