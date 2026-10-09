# Nowza: Android and Wear OS specification and implementation plan

Date: 2026-09-29

Status: Approved product defaults; proposed technical design and implementation sequence.

Scope of this document: planning only. No application changes, migrations, deployments, or store submissions are performed by creating this document.

## 1. Objective and release boundary

Add native Android phone and Wear OS clients that communicate with iPhone and Apple Watch clients through the existing Nowza account service and voice relay. Preserve the existing Apple product, including iPhone PushToTalk behavior.

**Complete Phase 0 before the first commercial/non-tester client release.** Phase 0 changes the Apple clients and service contracts while all affected users are testers. Android implementation can follow later as an additive release. A commercial Apple client built at the end of Phase 0 must be able to talk to a future Android client without an app update, new account, new friendship, or changed invite link.

That guarantee is specific to the Android expansion described here. It is not a promise that every future product feature or OS change can be supported without updating clients. Future incompatible changes require a new version and continued support for the commercial baseline; an upgrade-required screen is a recovery mechanism, not permission to break that baseline when Android launches.

## 2. Accepted product decisions

| Area | Decision |
| --- | --- |
| Authentication | Apple sign-in on iPhone; Google sign-in on Android. Watches receive their own Nowza sessions from their ecosystem's phone app. |
| Account identity | One login provider per account. Apple and Google logins create separate accounts even for the same human or email address. No linking, matching, merging, or migration between them. |
| Interoperability | Friendships, invitations, blocking, and conversations work between accounts regardless of provider. |
| Android receiving | Notification, then tap to listen for the first message. Automatic playback from an idle/locked state is deferred. |
| Wear OS receiving | Match Apple Watch: tap to hear the buffered opening, hold to reply, subsequent speech plays within an accepted conversation. |
| Wear OS setup | Android phone app required for setup, reauthentication when necessary, and account management. After setup, the watch connects to the service directly and can converse while the phone is unavailable. |
| Receiving device | Watch preferred by default, an explicit “Ring Me On” choice, and the device used in a conversation keeps that conversation. Do not ring the phone and watch simultaneously. |
| Release sequence | Validate phone and watch in the initial prototype. Android phone beta may ship before Wear OS if watch readiness lags. |
| Initial support | Small, named, physically tested device/OS list. Do not promise every Android phone or Wear OS watch. |
| Existing features | Preserve branding, mascot IDs/artwork, profiles/photos, friends, invites, favorites, blocking/reporting, account deletion, and support diagnostics. Account management remains on the phone. |
| Excluded | Groups, saved voice messages, account linking/migration, cross-ecosystem phone/watch pairing, non-Google-Play-services push implementations, and an Apple-client rewrite. |

The UI should not expose login providers as a property of friends. “Friend” and “conversation” have the same meaning across platforms. A person who switches ecosystems starts a separate account and must invite friends again.

## 3. Current code and consequences

These observations are from the repository, not an assertion that the deployed service runs the same revision. Refresh deployment state before implementing Phase 0.

| Current implementation | Consequence |
| --- | --- |
| [protocol.ts](server/src/protocol.ts) and [records.ts](server/src/records.ts): JSON controls, 20 ms binary Opus/PCM frames; relay forwards encoded audio | Retain this transport contract and the buffered-first-message model. Android does not require a replacement voice service. |
| [main.ts](server/src/main.ts): WebSocket plus streaming HTTPS GET/POST transport | Both transports can serve one conversation model. Keep HTTPS for Apple Watch; start Android with HTTPS for shared fixtures, then evaluate WebSocket if measurements justify it. |
| [accounts.ts](server/src/accounts.ts): `PLATFORMS = ["watch", "iphone"]`, `appleSubs`, Apple-specific user identity fields | Generalize identity and device records before commercial clients depend on them. Keep internal `u_` account IDs unchanged. |
| [api.ts](server/src/api.ts): Apple login and deletion/revocation, APNs-shaped device registration | Put provider-specific verification/revocation and delivery behind separate implementations. |
| [Account.swift](app/Packages/OverAndOutKit/Sources/OverAndOutKit/Account.swift): strict `Platform` enum in account responses | Adding an enum value to an existing response can fail decoding. Replace this contract and teach clients how to handle extensions now. |
| [relay.ts](server/src/relay.ts): two-platform ring selection; token presence approximates reachability | Separate device form factor, delivery mechanism, user availability, and actual receipt. A provider accepting a push is not evidence that the recipient saw it. |
| [apns.ts](server/src/apns.ts): Apple Watch alert and iPhone PushToTalk payloads | Preserve both adapters; add an FCM adapter later. Apple PushToTalk remains Apple-only. |
| [PhoneWatchLink.swift](app/iOS/PhoneWatchLink.swift) and [WatchAccount.swift](app/Watch/WatchAccount.swift): device-specific watch session provisioning | Reuse the server concept for Android Data Layer provisioning; do not copy the phone's session token onto its watch. |
| [session.ts](server/src/session.ts): provider-independent `sub`, `sid`, `dev` JWT claims; API checks stored sessions, relay admission currently verifies the token locally | Retain the token model; make watch revocation enforceable at relay admission and during active use rather than relying solely on a paired-phone message. |
| [invite.html](web/public/invite.html) and [Firebase deployment configuration](deploy/gcp/deploy-web.sh) | Preserve `/i/<code>` URLs; prepare routing for the new API version, then add Android App Links/store instructions later. |

The native Swift package imports Apple UI/audio/security frameworks. Reuse its behavior and protocol fixtures, not its build target. Kotlin phone/watch modules should share models, API access, framing, audio processing, and the conversation state machine. The phone and watch have separate Compose interfaces and platform lifecycle adapters. Google recommends [Compose for Wear OS](https://developer.android.com/training/wearables/compose).

## 4. User experience requirements

### 4.1 Android phone

1. Sign in with Google; choose a name and existing Nowza mascot or profile photo. Explain that Google and Apple logins are separate Nowza accounts.
2. Explain notifications and microphone access in context. Denied notifications must produce a visible “Notifications are off” state; the app must not present itself as reliably ringable in the background. Request microphone permission before first transmission, not merely to listen.
3. Show friends/favorites and the existing hold-to-talk interaction. Buffer the sender's opening words while the recipient decides whether to answer, following the existing relay behavior.
4. When idle, show a time-sensitive incoming-message notification with the sender's name and “Tap to listen.” Tapping opens the conversation and attempts to join that exact ring. No incoming speech plays solely because an idle app receives a push. When already open but outside an accepted conversation, show an in-app Answer/Decline prompt.
5. On answer, play buffered speech in order, then live speech. Hold Talk to request the floor; clearly distinguish waiting, speaking, listening, connection failure, and the other person speaking. Release, pointer cancellation, interruption, or loss of capture stops transmission.
6. Once accepted, continue receiving subsequent bursts during the conversation, including screen-off operation where supported by a foreground service. Never restart microphone capture automatically after an interruption. A reply requires a deliberate Talk action.
7. Show “End Conversation,” separate from the persistent availability setting. End, decline, timeout, sign-out, and an unavailable audio route must release audio/network resources and cancel the relevant incoming notification.
8. Keep the existing 45-second conversation inactivity window as the initial product behavior. A fresh incoming conversation after the window requires another tap. A delayed tap displays “This conversation has expired” rather than playing old speech or silently joining a newer ring.

Use native audio focus and routing with an appropriate visible foreground-service notification during active background conversations. Tapping a notification is a documented route into user-initiated foreground work; background microphone access has separate restrictions. Android 15+ also restricts audio-focus requests to the top app or a foreground service. Validate the declared service types and their lifecycle on hardware; use only the types actually required for playback/capture. [Foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start), [service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [audio focus](https://developer.android.com/media/optimize/audio-focus).

No full-screen incoming-call UI, permanent idle microphone service, battery-optimization exemption, or Telecom integration is required for the first Android release. Those are not substitutes for validating the selected tap-to-listen flow. Respect notification settings and Do Not Disturb; do not promise the iPhone PushToTalk interruption behavior on Android.

### 4.2 Wear OS

- Before provisioning, show “Open Nowza on your Android phone to finish setup,” with installation/open-phone assistance. Show the account being transferred; do not silently select a different Google account on the watch.
- Use the paired Android Data Layer for session provisioning and sign-out assistance only. Fetch friends, refresh the watch's own session, receive FCM, and stream audio directly through the backend. The phone need not remain connected after setup. [Data Layer guidance](https://developer.android.com/training/wearables/data/overview), [networking and FCM](https://developer.android.com/training/wearables/data/network-communication).
- Preserve the watch interaction in the accepted decisions. Support round screens, rotary navigation, accessible labels, adequate touch targets, haptics, and finger-release/cancel handling on the Talk control.
- When the wrist drops, the screen times out, or another activity interrupts, end active capture. Continue an already accepted listening session only while the supported service/audio lifecycle remains valid; otherwise leave cleanly and require another user action. Measure this behavior rather than assuming ambient mode keeps the app running.
- Detect a usable speaker or headset. If none is available, explain the problem before joining and consuming the buffered message. Handle route changes and headset disconnects without stuck transmission. [Wear OS audio output guidance](https://developer.android.com/training/wearables/apps/audio).
- Reauthentication requires the phone. Signing out on the phone revokes that phone session and its provisioned watch sessions on the server; a disconnected watch learns this on its next server contact. Cached account/audio data is cleared when revocation is learned.
- Because authentication depends on the companion app, declare this first release **non-standalone** (`com.google.android.wearable.standalone=false`). Independent conversations after setup do not make installation/authentication independent. Do not market untethered initial setup. [Standalone classification](https://developer.android.com/training/wearables/apps/standalone-apps).

### 4.3 Receiving-device policy

Define “one receiving device” explicitly rather than inheriting the current possibility of ringing several devices of the same platform:

1. Prefer the eligible device last used in the current conversation.
2. Otherwise use the user's preferred form factor; unset means watch when an eligible watch exists, otherwise phone.
3. Within a form factor, choose the most recently user-active eligible device, with a stable device-ID tie-break. Push token refreshes must not change this order.
4. If no candidate exists, or delivery is definitively rejected before it could ring, try the next candidate, then the other form factor.
5. If delivery is accepted or ambiguous, do not also ring another device. Lack of an answer is not proof of failed delivery. End with the existing no-answer behavior when the deadline passes.
6. A user may deliberately continue on another device in the same account. The relay selects one conversation owner and tells the previous device it moved. There is no handoff between the person's separate Apple and Google accounts.

“Eligible” means enabled, current session, supported protocol/audio capabilities, and a valid delivery route; foreground-only delivery also requires a live connection. It does not mean proven online. Exclude notification-only routes when the client reports notifications denied, but retain an in-app route while visible. Preserve iPhone PushToTalk's own availability semantics.

Prevent phone-notification mirroring from defeating the one-device policy. The selected device gets the actionable ring; a mirrored phone ring must not become an independent Wear OS answer path. Configure selective ring-notification bridging and verify behavior before and after watch provisioning. If enforcing an explicitly phone-only selection requires a local-only ring, document that intentional choice and test it; do not blanket-disable unrelated notifications. [Wear notification bridging](https://developer.android.com/training/wearables/notifications/bridger).

## 5. Contracts to establish in Phase 0

The following names and shapes are the proposed v2 implementation contract. They are not already implemented. Resolve any necessary wire-name adjustments while implementing Phase 0, then freeze fixtures before the first commercial build.

### 5.1 Identity and sessions

- Retain `users/<uid>`, `u_` IDs, friendship edges, invite URLs/codes, photo ownership, and existing session JWT claims.
- Store a single account identity as `{ provider: "apple" | "google", subject: string }`. Use a provider-namespaced, safely encoded/hashed `(provider, subject)` index with transactional uniqueness. Never key accounts or link them by email. Keep provider subjects out of public friend/profile responses.
- Backfill existing Apple mappings to the same `uid`; do not create replacement accounts. Production Google login stays disabled in Phase 0; synthetic Google identities are allowed only through existing isolated test mechanisms.
- Route verification and deletion/reauthentication through the account's stored provider. The request cannot select an unrelated provider to bypass account checks. Preserve Apple's revocation behavior. Define a provider-tagged deletion proof now: `proof: { provider: "apple", authorizationCode }`, with a reserved later Google form `proof: { provider: "google", identityToken, nonce }`. Validate proof freshness and subject against the signed-in account before irreversible work. This separates provider proof from the common deletion operation without adding account linking.
- Keep one active session per installation/device. Store the client kind on the server session. Watch sessions additionally record the provisioning phone's device ID and session generation; stale pairing replies cannot revive a watch after phone sign-out or account switching.
- Restrict companion-session creation to the authenticated phone account and the matching ecosystem's watch kind. Retry the same provisioning request idempotently. A watch cannot mint arbitrary phone/other-watch sessions.
- Revoke dependent watch sessions and push registrations on parent-phone sign-out/replacement. Check stored-session validity at relay admission and periodically during ongoing use, with a proposed maximum 10-second authorization-cache age. Fail closed for fresh admission on lookup failure. Measure latency/cost before freezing the implementation. Token format/key rotation is not required just to add Google.

Later, Google login uses Credential Manager and server-side ID-token verification: signature, issuer, allowed audience, expiry, and the login flow's nonce binding. Account lookup uses the verified subject. Google API access/refresh tokens are not needed merely to authenticate. [Credential Manager](https://developer.android.com/identity/sign-in/credential-manager-siwg), [backend verification](https://developers.google.com/identity/sign-in/android/backend-auth). The latter source's legacy Android UI examples are not the client implementation choice.

### 5.2 Device registration, settings, and delivery

Replace the overloaded `platform`/`ringOn` contract with separate concepts:

| Field | Meaning |
| --- | --- |
| `clientKind` | `ios`, `watchos`, `android`, or `wearos`. Server validates against the session's supported client kind. |
| `formFactor` | `phone` or `watch`; server derives it from the accepted client kind. |
| `preferredFormFactor` | `phone`, `watch`, or `null` for automatic preference. |
| `delivery` | Explicit provider/mode/token object: APNs alert, APNs PushToTalk, FCM notification, or foreground-only. APNs environment belongs only to APNs delivery. |
| `receiveMode` | `tap` or `automatic`; server permits automatic only for a supported capability (initially iOS PushToTalk). |
| `availability` | User's enabled/disabled choice and reported notification permission; not a claim of actual connectivity. |
| `capabilities` | Supported relay protocol, encode/decode codecs, and optional feature names. Server intersects them with supported behavior. |
| `clientVersion` / `build` | Diagnostics and compatibility reporting, not authentication. |

Registration remains bound to the session's `dev`; clients cannot write another device's registration. Derive provider/form-factor policy on the server rather than trusting submitted strings. Real-world OS attestation is not being introduced by these fields.

Namespace push-token ownership by provider and delivery scope (application/topic/environment as applicable), not token text alone. Preserve atomic reassignment, rotation cleanup, and compare-before-removing an invalid token so a delayed provider failure cannot delete a newer registration. Treat `app:`, `poll:`, and `local:` as legacy/test representations; production v2 uses explicit delivery modes, and test routes cannot be registered by ordinary production clients.

Use one provider-neutral delivery interface with outcomes `accepted`, `permanentlyRejected`, and `unknownOrTransient`. APNs error codes remain inside the APNs adapter. FCM-specific errors come later. “Accepted” must not be rendered as “heard” or “online.”

### 5.3 API and extension rules

- Introduce `/v2` for the account API and relay endpoints before commercial release. Keep the existing `/v1` behavior only for the tester migration window; do not silently change its shapes in place.
- Add an unauthenticated, cacheable `/v2/config` containing supported API/relay versions, deployment-controlled feature availability, compatibility guidance, and the approved relay base URL. It contains no credentials or user data. Keep a bundled approved relay fallback for temporary config unavailability; do not insert a new mandatory round trip into every ring.
- Require client kind/build and relay protocol version on v2 relay admission, before opening a stream or joining a conversation. Use headers for client metadata and bearer authentication. Keep API version, relay protocol version, and binary audio format version distinct.
- Preserve existing API operations under v2 with the revised identity/device/settings/deletion models. Provider-specific login endpoints are `/v2/auth/apple` and, later, `/v2/auth/google`. Both return the same Nowza session/profile shape. Preserve provider-independent friend/invite payloads.
- Keep errors as stable `{ error, message }` objects with optional detail fields. Define `client-upgrade-required`, `unsupported-protocol`, `unsupported-codec`, `ring-expired`, `session-ended`, and `provider-unavailable`. Use HTTP 409 for incompatible client/protocol negotiation and include supported-version details. Clients show a useful state and do not retry indefinitely or erase credentials for every error.
- Readers ignore unknown optional JSON fields. Extensible descriptive enums use an explicit unknown/fallback representation instead of failing the entire account. Unknown device kinds are not selectable; unknown avatars use the existing default; unknown optional control events are ignored. Unknown required features/protocols are rejected during admission. Malformed audio is rejected, not treated as an ignorable JSON extension.
- Servers validate write values strictly. Tolerant response decoding must not allow clients to request unsupported delivery modes, codecs, permissions, or lifecycle actions.
- Update phone/watch provisioning payloads and the watch notification extension's persisted prefetch metadata to carry their own schema versions. Support mixed tester phone/watch versions during migration or display an explicit update/setup state.

### 5.4 Relay audio and rings

Freeze relay protocol version 2 around the existing half-duplex behavior. Keep binary audio format version 1: codec byte, big-endian uint32 sequence, and one 20 ms payload; codec IDs 1 (16 kHz mono Opus) and 2 (16 kHz mono PCM16 little-endian). Keep HTTP record framing unchanged. Do not renumber codecs or add a container header to existing packet payloads.

All commercial baseline clients must decode both existing codecs. Advertise actual encode/decode support; admission/floor selection must not forward an unsupported codec to a recipient. Use a common supported codec or return an explicit failure. A relay transcoder is outside scope. Preserve per-burst codec reset, sequence handling, frame limits, speaking-floor arbitration, and buffered/live ordering. Prove that Apple's real Opus packets interoperate with the selected Android codec implementation. Android's documented Opus availability is not a Wear OS hardware guarantee. [Android formats](https://developer.android.com/media/platform/supported-formats), [libopus encoder API](https://opus-codec.org/docs/opus_api-1.5/group__opus__encoder.html).

Use one versioned ring envelope for in-app events, APNs, and later FCM:

```json
{
  "schemaVersion": 2,
  "ringId": "r_example",
  "conversationId": "c_example",
  "from": "u_sender",
  "fromName": "Friend",
  "burstId": "b_example",
  "pushSentAt": 1790726400000,
  "expiresAt": 1790726435000
}
```

The identifiers/timestamps above are illustrative. Each new ring attempt gets a new `ringId`, even if a conversation ID is reused. A retry of the same delivery attempt retains it. Payloads carry no credentials or audio. Provider adapters may wrap/serialize the fields as required; the logical meaning stays identical.

- The server validates account, conversation, current ring ID, target eligibility, and expiry when an answer/join arrives. A notification alone conveys no authorization.
- Add an authenticated pending-ring lookup for app launches without notification context. Resolve the current ring explicitly before joining; remove ambiguous “join whichever is pending” behavior from v2 notification handling.
- Answers and declines identify the ring; repeated operations are idempotent. An atomic claim prevents two devices answering the same ring independently. A deliberate later move uses the existing single-owner conversation behavior.
- Adopt the existing 35-second initial unanswered-ring timeout and 30-second answer-to-join grace as initial defaults. Before the unanswered deadline, an authenticated answer can create the bounded join grace; a delayed push cannot. Server deadlines are authoritative, and client clocks are only a display/early-dismissal aid.
- Expire/remove notifications and prefetch audio locally when possible. The server still rejects stale answers if notification cancellation was delayed or never delivered. No new cancellation push channel is required for the first Android release.
- Keep buffered voice ephemeral. No inbox, saved-message history, or cloud audio archive is introduced. Apply current buffer limits and delete cached audio on expiry, end, sign-out, or revocation.

## 6. Phase 0 — make the breaking changes before commercial users

**When:** now, before commercial distribution, even if Android work is deferred.

**Deliverable:** deployed v2 service, migrated tester data, updated iPhone/watch/notification-extension clients, and a frozen compatibility baseline. This document alone does not complete Phase 0.

| Work package | Implementation scope | Completion evidence |
| --- | --- | --- |
| P0.1 Freeze contract definitions | Specify schemas, field defaults, validation, errors, enum extension rules, protocol admission, timing, and binary fixtures from section 5. Add machine-readable schemas and language-neutral examples under a proposed `contracts/` directory. | Contract fixtures cover current Apple behavior, future Android peers, unknown optional fields/values, and unsupported required versions. |
| P0.2 Version service and clients | Implement `/v2` routing/config/negotiation in `api.ts`, `main.ts`, relay and clients; update Firebase Hosting/proxy rewrites, health checks, bots, and deployment smoke checks. Keep `/v1` temporarily isolated. | Both transports reject unsupported versions before audio; iPhone, watch, and extension use v2; temporary v1 clients still work during migration. |
| P0.3 Migrate identities and sessions | Generalize `accounts.ts`, provider adapters, deletion, session metadata, and dependent-watch revocation. Migrate Apple identity mappings in place. Implement stored-session checks for relay access with bounded caching. Google production login remains off. | Same Apple `uid`, friends, invites, photos, settings; no duplicate account under concurrent login; sign-out/revocation works with disconnected watches and stale JWTs. |
| P0.4 Migrate devices and ring preference | Implement explicit device/delivery/capability records and provider-scoped token ownership. Map `iphone` to `ios`/`phone`, `watch` to `watchos`/`watch`; map preference to form factor. | Existing APNs and iPhone PushToTalk still work, tokens rotate correctly, no cross-account delivery, unknown future device kinds do not crash Apple account decoding. |
| P0.5 Generalize routing and ring lifecycle | Implement the one-device rule, provider-neutral delivery outcomes, ring IDs/deadlines, exact pending-ring resolution, atomic answer/decline, and codec admission. Update prefetch cache keys/validation and iPhone PushToTalk payload parsing. | Duplicate/delayed push and answer races cannot replay expired audio, steal a newer ring, or play on two devices. Real-device Apple receiving and moves remain functional. |
| P0.6 Make Apple readers extensible | Update `Account.swift`, `RelayConnection.swift`, both controllers/settings, `PhoneWatchLink`, `WatchAccount`, and the notification extension. Keep friends provider-independent and preserve existing Apple UX. | Apple clients tolerate synthetic future fields, error codes, avatar IDs, and optional events; unsupported required behavior produces an explicit error. |
| P0.7 Generalize diagnostics and tooling | Add client kind, form factor, delivery provider/mode, protocol, codec, ring ID, and version dimensions to metrics/reports without changing existing event meanings silently. Update stats/admin/test tools and avoid credentials/audio in logs. | Apple dashboards remain interpretable; simulated Android delivery is distinguishable from actual APNs success; legacy metrics remain readable. |
| P0.8 Rehearse, deploy, and freeze | Execute section 7 with reviewed migration scripts, rollback artifacts, baseline clients, and the section 9 compatibility suite. | All Phase 0 release gates pass; oldest commercial client artifact and fixtures are retained; Android enablement demonstrably needs no Apple update. |

### Phase 0 status (2026-10-01)

Done 2026-10-02: PR #39 merged, the cutover complete (production all v2, no v1 data), device gates passed (runs 109–115), baseline tagged `commercial-baseline-v2` (build 182, relay 641ba74, API b23a94d). The frozen contract is
[contracts/README.md](contracts/README.md); the cutover is
[deploy/gcp/PHASE0_ROLLOUT.md](deploy/gcp/PHASE0_ROLLOUT.md). With three testers, Steve chose
(2026-10-01) to retire v1 at once rather than run a bridge: the service is v2 only, the tester
data is converted around a single deploy, and everyone updates to the v2 build in the same
window. Rollback is the previous revisions and the snapshot.

| Package | State | Evidence so far |
| --- | --- | --- |
| P0.1 | Done | `contracts/`: spec, 19 schemas, current/future/rejected examples, binary fixtures with real Apple Opus packets; checked by `server/test/contracts.test.ts` and the kit's `ContractTests` |
| P0.2 | Code done | Only `/v2` (the API, the relay on both transports, `GET /v2/config`), admission headers, `MINIMUM_BUILDS`; the operator's diagnostics on `/admin`; `/v2/**` Hosting rewrite; deploy smoke checks |
| P0.3 | Code done | Provider-neutral identities, the Google provider seam (dev double only), provider-tagged deletion, sessions with client kind and parent phone, companion revocation, stored-session checks at the relay (10 s cache, fail closed) |
| P0.4 | Code done | v2 device records only (kind, delivery, availability, capabilities, use order), scoped push-token ownership |
| P0.5 | Code done | Ring IDs and deadlines (required everywhere), one device per ring, answer claims, pending-ring lookup, ring-scoped prefetch, codec admission, provider-neutral delivery outcomes, FCM stub |
| P0.6 | Code done | Kit, iPhone, watch and extension on v2 only; tolerant enums; update-required state; watch link with schema versions and request IDs |
| P0.7 | Code done | Telemetry carries client kind, provider, mode and ring ID; simulated deliveries never count as delivered |
| P0.8 | Done | Production cut over 2026-10-01/02 with `tools/migrate-v2.ts`: snapshot, plan, apply (additive, before and after the deploy), verify, cleanup (removes the v1 data after the deploy), retire, restore (`--exact` for the rollback); tested on v1-shaped records |

Release gates: the cutover, the device runs (build 171, runs 109–115) and the baseline tag are done;
Helen's and Cooper's devices are still to update to build 182. Simulator runs on 2026-10-01 covered Apple↔Apple, Apple↔synthetic Android
(Google dev account, FCM stub) in both directions, and the update-required screen.

### Work deliberately left out of Phase 0

Do not implement an Android UI, enable production Google login/FCM, provision Android store apps, replace the relay transport, add end-to-end encryption, change Apple OS minimums, or migrate the Swift language mode solely for this project. The [Swift 6 migration plan](SWIFT6_MIGRATION_PLAN.md) is a separate workstream; coordinate shared-file changes without making it a prerequisite.

Build the provider interfaces and test doubles now. Implement Google verification and FCM production adapters later behind those interfaces. No speculative account-linking machinery, multi-region relay redesign, or generic plugin framework is required.

### Phase 0 commercial-release gates

- [ ] All tester Apple accounts retain their IDs, friendships, invitations, profile data, and preferences after migration.
- [ ] Updated iPhone, Apple Watch, and notification extension pass real-device receiving/transmitting tests, including iPhone automatic playback and watch prefetch/answer.
- [ ] A frozen Phase 0 Apple build exchanges Opus and PCM with synthetic Android/Wear peers through production-equivalent staging endpoints.
- [ ] That same unchanged Apple build passes against a later-service fixture with Google accounts, FCM delivery stubs, new device kinds, and optional fields enabled.
- [ ] Block/unfriend/delete, session revocation, preferred device, conversation moves, duplicate answers, stale rings, token rotation, and malformed audio pass on both transports.
- [ ] Hosting/proxy routing, session keys, API, relay, and client contract versions are consistent; test-only auth/delivery stays disabled in production.
- [ ] Tester-only v1 retirement is complete or isolated so no commercial build depends on it. No commercial build is released with the old strict `watch`/`iphone` contract.
- [ ] Migration recovery is rehearsed; minimum supported commercial contract and archived client artifacts are recorded.

## 7. Tester migration, deployment, and rollback

Treat this as a coordinated service/client transition, not an unannounced database rewrite. Prepare scripts and builds before requesting the operational approvals required by the project's deployment workflow.

> **Decision (Steve, 2026-10-01):** with three testers, all of whom update at once, there's no bridge release and no staged retirement. Steps 3–7 below collapse into one window: snapshot, upload the v2 build, convert the data additively, deploy the v2-only service, convert again for anything written in between, everyone updates, then remove the v1 data. Rollback is the previous revisions plus an exact snapshot restore. [deploy/gcp/PHASE0_ROLLOUT.md](deploy/gcp/PHASE0_ROLLOUT.md) is the runbook; the steps below are kept as the original plan.

1. **Inventory and snapshot.** Record deployed API/relay revisions, supported tester builds, schema counts, identity mappings, registration ownership, and session layouts. Take an access-controlled recoverable snapshot; preserve IDs and relationships. Do not place tokens, provider subjects, or production exports in Git.
2. **Rehearse in isolation.** Run the backfill against a disposable local/emulator snapshot with synthetic sensitive fields. Support dry-run, bounded batches, checkpoints, idempotent restart, collision detection, and before/after counts. Stop on ambiguous identity ownership rather than inventing mappings.
3. **Expand the service first.** Deploy a bridge release supporting old v1 behavior and v2. It must understand both old and new records and maintain both representations for changed fields throughout the rollback window. Serve existing v1 responses unchanged. Deploy relay protocol support before any v2 client can register or receive v2 rings.
4. **Backfill without changing IDs.** Migrate Apple identity indexes, device kind/preference, token ownership, and schema markers. Retain legacy fields/indexes until verification finishes. New Google registrations remain disabled. Concurrent sign-in/registration writes use the bridge logic so the backfill cannot overwrite newer state.
5. **Re-provision tester watches.** Historical watch sessions do not record a reliable parent-phone relationship. Do not guess. Have the updated phone mint a v2 child session for its paired watch; explicitly retire unclaimed legacy watch sessions/registrations after the announced tester cutoff. A tester may need to open both apps or sign in again; their account and friends remain intact.
6. **Roll out updated Apple clients.** Update phone, watch, and notification extension together; exercise mixed-version installation states and stale prefetched notifications. For each target, push rendering uses that target's negotiated payload version. In a mixed-v1/v2 tester conversation, retain a tested semantic adapter; if it cannot preserve safe ring handling, refuse that pairing clearly during the short coordinated tester update window.
7. **Verify and retire v1.** Confirm tester uptake with telemetry and direct checks; token age alone is insufficient. Announce a mandatory tester update before disabling v1 admission/registrations. Existing v1 apps may lack upgrade UI, so communicate this outside the app. Revoke obsolete registrations and drain old connections; they must not keep receiving unusable rings. Retain an explicit unsupported-version response instead of misleading generic failures.
8. **Freeze the commercial baseline.** Archive the first supported commercial iPhone/watch build pair, extension, source revision, schemas, binary/control fixtures, test results, and deployment revisions. Mark v2 plus relay protocol 2/audio format 1 as the baseline. Keep it supported when Android is enabled later.

**Rollback rules:** before v1 retirement, disable v2 enrollment and roll clients/service back only to a bridge release proven to read the current schema; pause writes while repairing any inconsistent migration. Do not deploy an old schema-unaware server onto v2-only data. After v1 retirement, prefer a v2-compatible corrective release; restoring obsolete registrations requires explicit controlled tester re-provisioning. Use a full snapshot restore only with a write freeze and a plan to reconcile all intervening changes. Do not discard accounts created after the snapshot. Record the tested rollback point and stop conditions at each deployment step.

Keep v1 removal, bridge-field cleanup, and the first commercial release as separate gates. Clean up legacy data only after rollback no longer depends on it and verification shows no remaining legacy writers. Requiring tester updates is acceptable during Phase 0; requiring existing commercial Apple users to update merely because Android launches is not.

## 8. Later implementation phases

### Phase 1 — phone and watch feasibility prototype

**Dependency:** Phase 0 contracts are implemented and stable; prototype-only work can use isolated staging while the production rollout finishes.

Create a proposed `android/` Gradle project with `phone`, `wear`, `core`, and `audio` modules. Use Kotlin/coroutines, phone Compose, and Wear Compose; retain the current Apple projects. Start with one physical Android phone and one physical Wear OS watch, then add a second manufacturer before setting support claims.

Implement the smallest complete path: test-account session, friends/peer selection, tap-to-answer notification, hold-to-talk, codec/framing, and direct relay traffic. Use staging-only credentials/test identities. Implement enough staging FCM delivery to measure real idle-device behavior, not just local notifications. Compare platform Opus with bundled libopus; choose based on exact packet compatibility, latency, maintenance, and watch availability. If native libraries are bundled, verify supported ABIs and current Android native-library packaging requirements.

Measure notification arrival, tap-to-first-audio, Talk-to-first-frame, turn switching, missed opening words, battery drain, Bluetooth routes, wrist-down behavior, and Wi-Fi/LTE/phone-proxy transitions. Android supports direct Wear OS networking and FCM, but this does not establish product latency or battery performance. [Wear networking](https://developer.android.com/training/wearables/data/network-communication).

**Exit:** both Android form factors send/receive with the frozen Apple baseline; first words are preserved; user-initiated audio works in the selected lifecycle; stale notifications never replay discarded audio. Document exact tested hardware/OS, selected codec/transport, measurements, and failures. Do not substitute automatic idle playback or an always-on service for the accepted UX if the prototype fails.

### Phase 2 — Google accounts and FCM service support

**Dependency:** Phase 0; can overlap Phase 1 using staging.

- Implement `/v2/auth/google` with Credential Manager's server-audience token flow and provider-namespaced account creation. Test same-email Apple/Google users remain distinct. Use a maintained Google verification library rather than duplicating cryptographic verification merely to retain the server's current dependency-free implementation.
- Implement Google reauthentication/account deletion under the v2 proof contract. Validate the provider subject before destructive work. Delete Nowza identities, sessions, tokens, profile data, and friendship edges; handle Google consent disconnection according to the actual integration. Do not require Apple's authorization code for Google accounts.
- Add FCM HTTP v1 delivery, credentials/IAM configuration, token rotation, permanent-error cleanup, bounded retries, and provider-neutral telemetry. Keep a server kill switch for new Android sign-ins and FCM enrollment that does not disable Apple traffic.
- Use high-priority messages for actual visible incoming rings, not silent keepalive. Render immediately, keep the receive handler short, and validate the effective received priority where relevant. Background audio/prefetch work must not be assumed to finish inside the FCM callback. [FCM priority guidance](https://firebase.google.com/docs/cloud-messaging/android-message-priority).
- Set FCM lifetime to the remaining ring deadline, discard already-expired requests, deduplicate by ring ID, and revalidate with the server on tap. Provider expiry supplements, rather than replaces, server checks. [FCM lifetime](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan).
- Add Android App Links verification and Play-install/reopen instructions to the existing invitation URL. Preserve Apple's associated-domain file and current invitation codes. Do not assume deferred deep linking through installation; prompt the recipient to reopen the original invite after setup. [Android App Links](https://developer.android.com/training/app-links).
- Update privacy/support copy and platform-neutral administrative/reporting tools for the actual new data handling. Prepare required store account-deletion access using the same provider-neutral service flow.

**Exit:** real Google sign-in and FCM work in staging; Apple baseline tests still pass unchanged; no mixed-provider account merging; transient FCM errors cannot remove current tokens or cause a second device to ring ambiguously.

### Phase 3 — Android phone beta

**Dependencies:** Phase 1 phone feasibility and Phase 2.

Complete onboarding, profiles/photos/mascots, friends/favorites/invites, Talk UI, preferences, block/report, sign-out/delete, diagnostics, and accessibility. Implement secure device-session storage, token refresh, notification permission/channel states, incoming-notification deduplication, and all conversation states from section 4.1. Keep Google provider tokens out of persistent storage unless a justified provider flow requires them; store the device's Nowza session using platform-protected storage.

Implement playback/capture service transitions, explicit capture start/stop, audio focus, output route changes, and network reconnection. Do not keep an idle relay connection or microphone service indefinitely just to appear available; use FCM for idle incoming rings. Show expired, unavailable, offline, and permission-denied states plainly. App resume and reboot recovery must re-establish only the state allowed by the OS and the user's availability setting.

**Exit:** phone beta passes the matrix below on the named supported devices, with real FCM, Google sign-in, Apple peers, background/screen-off accepted conversations, and a store-installed build. It may ship to testers while Wear OS remains in Phase 4.

### Phase 4 — Wear OS beta

**Dependencies:** Phase 1 watch feasibility, Phase 2, and the phone's provisioning/account-management flow from Phase 3.

Build the watch interface and shared Kotlin modules into a separate Wear artifact. Implement companion discovery/setup, dedicated child-session transfer and refresh, account-switch/sign-out handling, direct FCM/API/relay, preferences, friend selection, Talk control, notification bridge policy, speaker/headset checks, and diagnostics. Package/sign the phone and watch apps consistently with Data Layer requirements. Recheck current Play distribution requirements before publishing. [Data Layer](https://developer.android.com/training/wearables/data/overview), [Wear packaging](https://developer.android.com/training/wearables/packaging).

Test first install before the phone app, phone unavailable after setup, phone replacement, watch reinstall, session expiry, wrist-down capture cancellation, low-power conditions, LTE-only operation, and notification dismissal/answer races. Select exact supported watch models and minimum OS from evidence; retaining the original Apple OS minimums is independent of this choice.

**Exit:** watch beta passes the direct-connectivity, battery, lifecycle, and one-device-ring gates without requiring the phone to relay audio. Store metadata accurately states the phone setup dependency.

### Phase 5 — compatibility, staged rollout, and support

Re-run the frozen commercial Apple build against the actual Google/FCM service and actual Android phone/watch clients. Exercise all directed sender/receiver combinations among iPhone, Apple Watch, Android phone, and Wear OS, plus same-platform pairs. Compare Apple latency/reliability with its pre-Android baseline.

Run a limited tester rollout with service-side feature controls and dashboards segmented by client kind, OS/build, delivery provider, codec, and outcome. Expand hardware support only after test evidence. Publish Android phone first if ready; publish Wear OS after its independent gate. Preserve the Apple contract and operations throughout. Freeze a new oldest-supported Android baseline before commercial Android distribution.

**Exit:** all must-pass criteria below are met; measured performance and supported-device list are approved; support can diagnose notification permission, no-answer, expired-ring, session, network, and audio-route failures without collecting voice content.

## 9. Validation and release evidence

### Automated checks

Use the existing Node test runner (`cd server && npm test`), the disposable Firestore emulator suite (`npm run test:firestore`), and Swift package tests (`cd app/Packages/OverAndOutKit && swift test`) where relevant. Add Kotlin unit/instrumentation tests with the new project. Exact targeted commands belong in each implementation PR. Do not run migration/deletion tests against retained production data.

| Area | Required evidence |
| --- | --- |
| Frozen client compatibility | Original Phase 0 binaries/fixtures against later-service changes; same protocol and API behavior with Android enabled and disabled. “Latest clients pass” is insufficient. |
| Identity/migration | Idempotent backfill, concurrent sign-in, duplicate-provider-index rejection, unchanged `uid`/relationships, same-email separate accounts, correct-provider deletion. |
| Watch/session lifecycle | Duplicate setup requests, stale replies, account switch, parent sign-out while watch offline, replaced session token, relay revocation and active-conversation cutoff. |
| Routing/push | Preference/default/stickiness, multiple devices of one form factor, definitive failure fallback, transient failure without double ring, notification permission changes, bridged notifications, token rotation/reassignment. |
| Ring lifecycle | Duplicate/out-of-order push, tap after deadline, new ring in same conversation, concurrent answers, decline-vs-answer, block/delete during buffering, prefetch expiry, lost notification cancellation. |
| Protocol/audio | Shared byte fixtures, both codecs and transports, real Apple-to-Android Opus and reverse direction, burst reset, first-word preservation, partial HTTP records, malformed/oversized frames, floor races, no-common-codec rejection. |
| Feature parity | Cross-provider invite acceptance, favorites/profile photos/unknown mascots, blocking/reporting/deletion, diagnostics and account-management access. |

### Physical-device matrix

For the selected phone/watch models, record OS/build, app build, network, output route, and receiver lifecycle for each result:

- Foreground idle, background idle, screen locked, Doze, process reclaimed, user force-stopped, rebooted, and updated app. Treat force-stop and pre-first-unlock behavior as distinct conditions; do not promise wake behavior without evidence.
- Notifications denied/channel muted, microphone denied, Do Not Disturb, battery saver, connectivity lost/restored, and expired login.
- Phone-proxied watch networking, Wi-Fi-only watch, LTE-only watch where supported, and transitions between them.
- Built-in speaker, Bluetooth headset, relevant hearing-aid routes when available, route disconnect mid-burst, music interruption, and incoming cellular call.
- Phone and watch both installed, watch not yet set up, explicit phone selection, explicit watch selection, auto default, and deliberate conversation move.

### Acceptance thresholds

Hard requirements: no unauthorized delivery; no automatic speech from a new idle Android ring; no microphone capture without the user's transmit action; no replay of expired speech; no two active owners of one account's conversation; no lost opening words in controlled successful runs; no Apple update needed for the Android launch.

Initial measurement goals, **proposed rather than observed promises**: median tap-to-first-audio at or below 1 second and p95 at or below 2 seconds on a stable awake network; p95 reply Talk-to-first-frame at or below 1 second on an established conversation. Report cold/Doze/LTE timings separately. Capture at least 30 completed attempts per principal measured condition, report all failures/timeouts, and do not hide them by timing only successful joins. Revise goals explicitly after the prototype if hardware/network evidence warrants it.

Measure idle and conversation battery drain against an otherwise comparable control on each named watch, including an overnight idle run and a scripted conversation session. Set a numeric battery budget after Phase 1 and before beta release; lack of a budget/result is an open release gate, not assumed success.

## 10. Sequencing, deliverables, and decisions still required

The critical sequence is **Phase 0 commercial compatibility freeze → Phase 1 hardware proof → production-ready Phase 2 adapters → phone beta / watch beta → staged rollout**. Phase 2 staging work can overlap the prototype. Phase 0 does not wait for a polished Android app or production Google/FCM enrollment.

Suggested reviewable implementation batches:

1. Contract schemas, byte fixtures, extension rules, and v2 test scaffolding.
2. Identity/session/device storage changes and migration tooling, with the v1 bridge.
3. Versioned API/relay/push/ring changes, routing, and diagnostics.
4. Apple phone/watch/extension adoption and mixed-version tests.
5. Migration rehearsal, operational rollout, commercial baseline archive, and v1 retirement.
6. Minimal Android phone/watch prototype and measured feasibility report.
7. Google authentication, FCM, invitations, and administrative support.
8. Android phone product completion and tester release.
9. Wear OS product completion and tester release.
10. Frozen-client cross-platform regression, support documentation, and staged commercial rollout.

Batches 2–4 are interdependent and must not be deployed as incompatible partial releases. Keep each batch reviewable; use the bridge/feature controls to separate merge order from activation order. Existing Apple feature/fix work may continue, but the first commercial artifact must include the Phase 0 contract changes.

Engineering can settle codec implementation, transport choice, exact module boundaries, and wire-name details within Phase 0/1 using measurements and this scope. User decisions still needed at the relevant gate are the actual beta hardware list, acceptable measured latency/battery tradeoffs, and release/deployment timing. No additional account-linking or automatic-playback UX decision is blocking this plan. Calendar estimates should follow the Phase 1 evidence and team capacity, rather than assume watch lifecycle work is a routine UI port.

## 11. Reference basis

Repository links above describe the inspected implementation. External links support platform constraints, not proof that Nowza already implements them. Official Android/Firebase/Google documentation was reviewed on 2026-09-29; recheck target SDK, service declarations, signing, account deletion, and Play distribution requirements when building/submitting the Android releases.

The separation between accepted product defaults and proposed implementation details is intentional. Changing a default (for example, requiring automatic idle playback or independent watch sign-in) requires revisiting scope and feasibility; choosing a different compliant codec library does not.
