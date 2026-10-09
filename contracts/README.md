# Over&Out service contract, version 2

This directory freezes the contract between the Over&Out clients (iPhone, Apple Watch, the
watch's notification service extension, and later Android phones and Wear OS watches) and the
service (the account API on Cloud Run and the relay nodes). It is Phase 0 of
[ANDROID_WEAR_OS_PLAN.md](../ANDROID_WEAR_OS_PLAN.md): the first commercial Apple build speaks
this contract, and a later Android launch must not need that build to change.

- `schemas/`: JSON Schemas (draft 2020-12) for every JSON body below.
- `examples/`: language-neutral examples. `examples/current/` is what today's Apple clients
  send and receive; `examples/future/` is what a later service may send them (Google accounts,
  Android and Wear OS devices, FCM delivery, unknown fields, values and events), and what
  later clients send (end-to-end encryption). Apple clients must decode every response example
  in both. `examples/rejected/` holds requests the server must refuse.
- `fixtures/`: binary audio frames and relay records, as hex; `e2ee.json`, the end-to-end
  encryption test vectors (made by `server/tools/e2ee-vectors.ts`).

The server tests (`server/test/contracts.test.ts`) check the examples against the schemas and
against the server's own parsers; the kit's tests (`ContractTests.swift`) decode them in Swift.

Three versions are kept apart, and change independently:

| Version | Value | Where it's named |
| --- | --- | --- |
| API version | 2 | the path: `/v2/…` |
| Relay protocol version | 2 | `X-OAO-Relay-Protocol` on relay admission |
| Binary audio format version | 1; 2 specified, not yet served | `relay.audioFormats` in config; `format` on talk-start |

Version 1 (the `/v1/…` paths, no admission headers) was the tester-only contract before Phase 0.
It's retired: the service no longer serves it, and no build that speaks it is supported.

## Extension rules

These are what let a commercial client keep working when Android arrives.

1. **Readers ignore unknown JSON fields.** Every object may gain optional fields.
2. **Descriptive enums are open.** A client keeps an unknown value as "unknown" rather than
   failing to decode the whole response:
   - an unknown `formFactor` or `clientKind` in a list is skipped (never selectable);
   - an unknown `avatar` draws the default mascot;
   - an unknown `signInProvider` is shown as nothing;
   - an unknown error `code` falls back to its HTTP status and `message`.
3. **Unknown optional relay events are ignored.** A client ignores a control message whose
   `type` it doesn't know. The server never sends a new required event to a client that didn't
   advertise the feature for it.
4. **Unknown required things are refused up front.** A relay protocol, audio format or codec a
   peer can't handle is refused at admission or when the floor is given, never discovered
   mid-burst. Malformed audio is dropped, not treated as an extension.
5. **Writes are strict.** The server validates every value a client writes against what it
   supports. A tolerant reader is never a licence to request an unsupported delivery mode,
   codec, permission or action.
6. **Codec IDs are never renumbered**, and no container header is added to existing frames.

## Common request headers

| Header | On | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <token>` | every call but sign-in and config | the device's Over&Out session |
| `X-OAO-Client-Kind` | every v2 call; required on relay admission | `ios`, `watchos`, `android` or `wearos` |
| `X-OAO-Client-Version` | every v2 call | the marketing version, e.g. `1.0` |
| `X-OAO-Build` | every v2 call; required on relay admission | the build number, e.g. `165` |
| `X-OAO-Relay-Protocol` | relay admission | `2` |
| `X-OAO-Decode` | relay admission | codecs this device plays, e.g. `opus16k,pcm16le16k` |
| `X-OAO-Encode` | relay admission | codecs this device sends, e.g. `opus16k` |

Client metadata is for compatibility and diagnostics, never authentication.

## Errors

Every error is JSON: `{"error": "<code>", "message": "<text for people>"}`, plus optional
detail fields. Codes are stable; messages may change. Clients don't retry indefinitely, and
only `session-ended`, `unauthorized` and `no-account` end the stored session.

| Code | Status | Meaning, and detail fields |
| --- | --- | --- |
| `client-upgrade-required` | 409 | This build is below `minimumBuild`. Show "Update Over&Out"; keep the session |
| `unsupported-protocol` | 409 | Relay protocol not supported. `supported: {relayProtocols: [2]}` |
| `unsupported-codec` | 409 | No codec in common. `supported: {codecs: [...]}` |
| `ring-expired` | 410 | The ring was answered elsewhere, replaced by a newer ring, or ran out |
| `ring-answered-elsewhere` | 409 | Another of the account's devices claimed this ring |
| `session-ended` | 401 | Signed out, replaced, revoked with the parent phone, or the account was deleted |
| `token-expired` | 401 | Refresh, then retry once |
| `unauthorized` | 401 | No usable token |
| `provider-unavailable` | 503 | This sign-in or delivery provider isn't enabled. `provider` |
| `temporarily-unavailable` | 503 | A lookup failed; the request was refused rather than guessed |
| `wrong-provider` | 400 | A deletion proof for a provider the account doesn't use |
| `unsupported-delivery` | 400 | A delivery this client kind can't register |
| `bad-request`, `bad-json`, `bad-name`, `name-not-allowed`, `bad-avatar`, `bad-id`, … | 400 | The request itself is wrong |
| `no-account`, `not-friends`, `invite-not-found`, `no-photo`, `not-found` | 404 | What it names isn't there (or isn't the caller's to see) |

## Configuration: `GET /v2/config`

Unauthenticated and cacheable (`Cache-Control: public, max-age=300`). It holds no credentials
or user data. Clients fetch it at launch and on coming to the foreground, never on the ring
path; they keep the last good copy and a bundled fallback relay. A relay `baseUrl` is used
only if its host is approved: the bundled relay host, or `https` on a host under
`overandout.app`.

```json
{
  "schemaVersion": 1,
  "api": { "versions": [1, 2] },
  "relay": { "baseUrl": "https://relay-1.overandout.app", "protocols": [2], "audioFormats": [1], "codecs": ["opus16k", "pcm16le16k"] },
  "features": { "googleSignIn": false, "fcmDelivery": false },
  "compatibility": { "minimumBuilds": { "ios": 0, "watchos": 0 }, "message": null },
  "timing": { "ringUnansweredMs": 35000, "answerJoinGraceMs": 30000, "conversationIdleMs": 45000 }
}
```

`minimumBuilds` maps a client kind to the lowest build the service still supports; a missing
kind means no minimum. A build below it shows an update screen and keeps its session.

## Identity and sessions

An account has exactly one sign-in identity, `{provider: "apple" | "google", subject}`. Apple
and Google sign-ins make separate accounts, even for the same person or email address; nothing
links, matches or merges them. Accounts keep their `u_` IDs. Provider subjects never appear in
friend, invite or profile responses.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v2/auth/apple` | `{identityToken, nonce, name?, deviceId, clientKind: "ios"}` | `{token, expiresAt, user, created}` |
| `POST /v2/auth/google` | `{identityToken, nonce, name?, deviceId, clientKind: "android"}` | the same; `503 provider-unavailable` until enabled |
| `POST /v2/auth/refresh` | none (a token up to a year past expiry) | `{token, expiresAt}` |
| `POST /v2/auth/device` | `{deviceId, clientKind, requestId}` | `{token, expiresAt, deviceId, clientKind, parentDeviceId}` |
| `POST /v2/auth/signout` | none | `{}` |

- **One session per device.** Signing in again on a device replaces its session.
- **Companion sessions** (`/v2/auth/device`): only a phone session can make one, and only for
  its own ecosystem's watch kind (`ios` → `watchos`, `android` → `wearos`). The watch session
  records the phone's device ID and the phone session it came from. Repeating a request with
  the same `requestId` returns the same session, so the phone can retry. A watch can't make
  sessions.
- **Revocation.** Signing out on a phone, or signing in there again, ends its watches'
  sessions and push registrations too. A watch that was offline learns this at its next
  request (`401 session-ended`) and clears its cached account and audio.
- **The relay checks sessions.** Relay admission checks the stored session, failing closed
  (`503 temporarily-unavailable`) if it can't; an open connection is checked again at least
  every 10 seconds and closed with `session-ended` once the session is gone.

The session token is unchanged: an Ed25519 JWT with `sub` (user), `sid` (session) and `dev`
(device) claims, 30 days, refreshable for a year while the session exists.

## The account

`GET /v2/me`:

```json
{
  "id": "u_lddgnN9Qtcspo663",
  "name": "Steve",
  "photoVersion": 1790726400000,
  "avatar": "honey",
  "signInProvider": "apple",
  "preferredFormFactor": "watch",
  "rollOver": true,
  "formFactors": ["phone", "watch"],
  "diagnosticsRequestedAt": 1790726400000
}
```

- `preferredFormFactor`: `phone`, `watch`, or absent for automatic (the watch when one can be
  rung, else the phone). Set with `PATCH /v2/me {preferredFormFactor: "phone" | "watch" | null}`.
- `formFactors`: the form factors with a device registered for rings. Unknown values are skipped.
- `PATCH /v2/me` also takes `name`, `avatar` (a mascot ID or null) and `rollOver` (boolean).

Friends, invites, blocks, reports and photos: `GET
/v2/friends` → `{friends: [{id, name, since, photoVersion?, avatar?, favorite?,
lastMessageAt?}]}`, and so on. A friend never says which provider their account uses.

**Deletion**: `DELETE /v2/me {proof}`. The proof is checked against the account's own
provider, and its subject must be the account's, before anything is deleted:

- `{"provider": "apple", "authorizationCode": "…"}` (revokes the Apple token);
- `{"provider": "google", "identityToken": "…", "nonce": "…"}` (reserved; `503
  provider-unavailable` until Google sign-in is enabled).

A proof for the other provider is `400 wrong-provider`.

## Devices and delivery

`PUT /v2/me/device` registers this session's device:

```json
{
  "clientKind": "ios",
  "delivery": { "provider": "apns", "mode": "pushtotalk", "token": "…", "environment": "production" },
  "availability": { "enabled": true, "notifications": "authorized" },
  "capabilities": { "relayProtocols": [2], "audioFormats": [1], "decode": ["opus16k", "pcm16le16k"], "encode": ["opus16k"], "features": [] },
  "clientVersion": "1.0",
  "build": "165"
}
```

The answer is `{"device": {...}}`: the stored registration, with what the server derived.

| Field | Rules |
| --- | --- |
| `clientKind` | Must match the session's client kind. The server derives `formFactor` from it: `ios`/`android` → `phone`, `watchos`/`wearos` → `watch` |
| `delivery` | One of the modes below, allowed for the client kind |
| `receiveMode` | Derived, never written: `automatic` for APNs PushToTalk, `tap` otherwise |
| `availability.enabled` | The person's on/off choice; `false` = never rung. Default `true` |
| `availability.notifications` | `authorized`, `denied` or `unknown` (default). `denied` excludes notification-only deliveries |
| `capabilities` | Intersected with what the service supports. Default: protocol 2, audio format 1, decode both codecs, encode `opus16k` |
| `clientVersion`, `build` | Diagnostics only |

| Delivery | Client kinds | Rung by |
| --- | --- | --- |
| `{provider: "apns", mode: "alert", token, environment}` | `watchos` | a time-sensitive APNs alert, tapped to listen |
| `{provider: "apns", mode: "pushtotalk", token, environment}` | `ios` | a PushToTalk push; plays at once |
| `{provider: "fcm", mode: "notification", token}` | `android`, `wearos` | a high-priority FCM message (later; `503 provider-unavailable` until enabled) |
| `{provider: "relay", mode: "foreground"}` | all | a `ring` event over this device's open relay connection only |

`environment` is `sandbox` or `production` and belongs only to APNs. The test delivery
(`{provider: "test", mode: "connection"}`: rung over any of the account's open relay
connections, as a bot is) exists only on servers run for tests.

A push token belongs to one registration: the same provider, scope (APNs topic and environment)
and token registered elsewhere removes the older registration. A token APNs (or later FCM)
rejects for good is removed only if it is still the device's current token.

## Choosing the device that rings

One device rings for each ring, never two at once:

1. the device the person last used in this conversation, if it can still be rung;
2. otherwise their preferred form factor (automatic: the watch if one is eligible, else the
   phone); within it, the most recently used eligible device, ties broken by device ID (a push
   token refresh doesn't change the order);
3. if no device can be rung, or the provider rejects the device for good before it could ring,
   the next device, then the other form factor;
4. once a provider accepts a ring, or answers ambiguously, no other device is rung for it. No
   answer isn't proof the ring failed; the ring simply runs out.

The person's opt-in "Roll Over to iPhone" is the one exception: 12 s after an unanswered,
undeclined ring to their watch, the same ring goes to their phone, within the same deadline.

Eligible means: availability enabled, a current session, relay protocol 2 and a codec in
common, and a usable delivery (a foreground delivery needs the device's relay connection
open). It doesn't mean online.

## Rings

Every ring carries one envelope, in the in-app `ring` event, the APNs payload (top-level
keys; PushToTalk also inside `aps`) and later FCM data:

```json
{
  "schemaVersion": 2,
  "ringId": "r_3qgS0mXPRkK8z1yA",
  "conversationId": "4f1c7f7e-9b1a-4f0b-9a55-1f6a0c3e2d11",
  "from": "u_NvlyGM47nb3JKca_",
  "fromName": "Test Bot",
  "burstId": "8b0c6c52-3d0f-4b8e-a1f4-0d9e0f1a2b3c",
  "pushSentAt": 1790726400000,
  "expiresAt": 1790726435000
}
```

- A new ring (the first Talk to someone not in the conversation, or after the last ring ran
  out) gets a new `ringId`, even in the same conversation. Delivering it to another device
  (a fallback, or Roll Over to iPhone) keeps the `ringId`.
- Times are the server's clock, in ms. `expiresAt` is when an unanswered ring is abandoned: 35 s
  after it was first sent.
- The envelope authorizes nothing and carries no credentials or audio. Everything is checked
  again when the device answers.

| Call (relay host) | Body or query | Answer |
| --- | --- | --- |
| `POST /v2/rings/answer` | `{conversationId, ringId}` | `{ring}`: this device has the ring, and 30 s to join. `410 ring-expired`; `409 ring-answered-elsewhere` |
| `POST /v2/rings/decline` | `{conversationId, ringId}` | `{}`; idempotent. Stops Roll Over to iPhone; the ring then runs out as usual |
| `GET /v2/rings/pending` | none | `{rings: [envelope]}`: unanswered rings for this account, newest first |
| `GET /v2/rings/audio?conversationId=&ringId=` | none | the held message as relay records, for prefetching. `410 ring-expired` |

- Before the deadline, answering claims the ring for this device: a second device's answer or
  join gets `ring-answered-elsewhere` (or `moved`, as in a conversation move). Repeating an
  answer from the same device is harmless.
- An answer after the deadline, or naming a ring that isn't the conversation's current one,
  gets `ring-expired`. The client shows "This conversation has expired" and plays nothing,
  including anything it prefetched for that ring.
- A delayed push can't extend a ring; only an authenticated answer before the deadline starts
  the 30 s join grace.
- Clients key prefetched audio by `ringId`, and delete it on expiry, end, sign-out and
  revocation. The relay keeps no audio past a ring's end: there is no inbox or archive.

## The relay

Endpoints on the relay host: `GET /v2/relay` (WebSocket upgrade), `GET /v2/relay/stream`
and `POST /v2/relay/send` (the HTTPS transport), the ring calls above, `POST /v2/metrics` (a
conversation's timeline) and `GET /v2/time`.

**Admission.** Both transports check, before opening a stream or joining a conversation: the
session (as above), `X-OAO-Client-Kind` and `X-OAO-Build` (`409 client-upgrade-required` below
the minimum), `X-OAO-Relay-Protocol` (`409 unsupported-protocol` unless 2), and the codecs
(`409 unsupported-codec` if the device decodes none the service supports). A WebSocket that
fails admission gets the same status and JSON body instead of the upgrade.

`GET /v2/relay/stream?clientTime=<ms>[&join=<conversationId>&ring=<ringId>][&resumeBurst=<id>&resumeFrom=<seq>]`
joins in the same request when `join` is given. `ring` names the ring being answered; a
rejoin after a dropped stream (`resumeBurst`) or a deliberate move needs none.

**Control messages** are JSON (WebSocket text frames, or type-1 records). Client to server:

| Type | Fields |
| --- | --- |
| `hello` | `clientTime` (WebSocket only; the stream's first record is the `hello-ack`) |
| `talk-start` | `to`, `burstId`, `codec` (`opus16k` or `pcm16le16k`) |
| `talk-end` | `burstId` |
| `join` | `conversationId`, `ringId?`, `resume?: {burstId, fromSeq}` |
| `leave` | `conversationId`, `reason?`: `end` when the person tapped End (the friend's app ends too); absent when the app left by itself (an idle timeout, a PushToTalk call iOS ended) |

Server to client (clients ignore unknown types and fields):

| Type | Fields |
| --- | --- |
| `hello-ack` | `clientTime`, `serverTime` |
| `ring` | the ring envelope |
| `floor-granted` | `burstId`, `conversationId`, `pushed` |
| `floor-denied` | `burstId`, `holder` |
| `talk-refused` | `burstId`, `reason`: `not-friends`, `unavailable` or `unsupported-codec` |
| `joined` | `conversationId`, `peer`, `replayBursts`, `resumedFrames?`, `ringId?` |
| `burst-start` | `conversationId`, `burstId`, `from`, `replay`, `resumed?`, `codec?` |
| `burst-end` | `conversationId`, `burstId` |
| `peer-left` | `conversationId`, `peer`, `reason?`: `ended` (they tapped End: end the conversation here too), `left` (their app left by itself; a new Talk rings them again) or `disconnected` (their stream dropped; they may resume). Absent from relays before 2026-10-07 |
| `moved` | `conversationId`: the account continued this conversation on another device |
| `conversation-ended` | `conversationId`, `reason` (`not-friends`) |
| `ring-timeout` | `conversationId`, `peer`, `droppedBursts` |
| `session-ended` | none; the connection closes next |
| `ping` | none (HTTPS keepalive, every 15 s) |
| `error` | `message`, `code?` (`ring-expired`, `ring-answered-elsewhere`, `unknown-conversation`, `unsupported-codec`, `burst-too-long`, `too-much-audio`, `unknown-message`) |

Half-duplex rules are unchanged: one speaker per conversation (the floor); a burst ends at
`talk-end`, after 60 s, or when the held audio would pass 4 MiB; the recipient hears held
bursts in order, then live audio; a burst's frames are kept 30 s after it ends so a dropped
listener can resume.

**Codec admission.** `talk-start` names the burst's codec. The floor is refused
(`talk-refused`, `unsupported-codec`) if the listener in the conversation, or the device the
ring would go to, can't decode it. Frames of another codec than the burst's are dropped. Every
commercial client decodes both codecs.

## Binary audio (format 1)

Unchanged since the spike. One frame per WebSocket binary message, or per type-2 record:

```
byte 0      codec: 1 = opus16k (16 kHz mono Opus, one 20 ms packet)
                   2 = pcm16le16k (16 kHz mono PCM16 little-endian, 640 bytes)
bytes 1..4  sequence number within the burst, uint32 big-endian, from 0
bytes 5..   the payload
```

An Opus payload is 1–1275 bytes. Anything else (an unknown codec, a PCM payload that isn't
640 bytes) is malformed and dropped. Each burst starts the decoder afresh.

**Records** (the HTTPS transport): `type` (1 byte: 1 = JSON, 2 = audio frame), length (uint32
big-endian, at most 64 KiB), then the payload. A partial record waits for the rest.

## End-to-end encryption (binary audio format 2)

Specified here and tested (`fixtures/e2ee.json`, `server/src/e2ee.ts`, the kit's `E2EE.swift`),
but not yet served: no client sends it and the relay doesn't accept it until the server and app
changes of [E2EE_SPEC.md](../E2EE_SPEC.md) land (PRs B and C). Only audio is encrypted; the relay
forwards ciphertext it can't read.

### Cryptography

| Use | Algorithm |
| --- | --- |
| Signatures | Ed25519 (32-byte keys, 64-byte signatures) |
| Sealing a message key to a device | HPKE (RFC 9180), base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305; single-shot, empty additional data |
| Frames | ChaCha20-Poly1305 |
| Key IDs, fingerprints | SHA-256 |

**Signed bytes are never JSON.** Every signed or sealed byte string is a context label, then
fields, each encoded as:

- `str` and `bytes`: a uint16 big-endian length, then the bytes (UTF-8 for `str`);
- `u8`, `u16`: big-endian;
- `u64`: uint64 big-endian (times are milliseconds since 1970).

The label itself is the first `str`. JSON carries certificates, signatures and HPKE outputs as
standard base64 with padding.

### Keys and certificates

Each phone has an **identity key** (Ed25519). Each device (a phone, or one of its watches) has a
**signing key** (Ed25519), certified by its phone's identity key, and an **encryption key**
(X25519), certified by the device's signing key and rotated weekly. A certificate is its body
followed by a 64-byte Ed25519 signature over the body.

| Certificate | Body | Signed by |
| --- | --- | --- |
| Phone (`phoneCert`) | `str("oao-phone-v1")`, `str(userId)`, `str(deviceId)`, `bytes(identityKey)`, `u64(issuedAt)` | its own identity key |
| Device (`deviceCert`) | `str("oao-device-v1")`, `str(userId)`, `str(deviceId)`, `str(clientKind)`, `bytes(signingKey)`, `bytes(issuer's identityKey)`, `u64(issuedAt)` | the issuing phone's identity key |
| Encryption key (`encCert`) | `str("oao-enckey-v1")`, `str(userId)`, `str(deviceId)`, `bytes(encKey)`, `u64(issuedAt)`, `u64(notAfter)` | the device's signing key |

- A device certificate is valid only with a phone certificate of the same account whose identity
  key is its issuer's. An encryption key certificate is valid only with a device certificate of
  the same account and device.
- `notAfter` is 30 days after `issuedAt`. A sender never seals to an expired key.
- **Key ID:** the first 8 bytes of SHA-256(encKey), as 16 lowercase hex characters.
- **Fingerprint** (what people compare; in invite links' fragments): the first 16 bytes of
  SHA-256(`str("oao-fingerprint-v1")` ‖ identityKey), base64url without padding (22
  characters).

A device registers its keys with `PUT /v2/me/device`: `"e2ee": {phoneCert?, deviceCert,
encCert}` (`phoneCert` from phones). Friends see them in `GET /v2/friends`, on each friend:

```json
"keys": {
  "phones": ["<phoneCert>"],
  "allDevicesHaveKeys": true,
  "devices": [{ "deviceId": "…", "clientKind": "watchos", "deviceCert": "<base64>", "encCert": "<base64>" }]
}
```

`allDevicesHaveKeys` is false while any registered device has not published certificates.
During PR C the apps do not start an encrypted burst in that state. A friend whose keys have
already been seen cannot be downgraded to format 1.

A PR C sender starts format 2 only when every registered recipient device has a valid,
unexpired key and seals to all of them. Missing or invalid keys stop the encrypted Talk;
once this sender has seen keys for the friend, it cannot fall back to format 1.

Over WatchConnectivity, the watch's session request adds `signingKey` (its raw Ed25519 public
key, base64); the phone's reply adds the watch's `deviceCert` and the phone's `phoneCert`.

### The key bundle

A message (burst) has its own random 32-byte message key. For the first encrypted Talk in a
conversation the sender chooses a random UUID for `conversationId`; the relay uses it. For later
Talks the sender uses the ID already given in `floor-granted` or `joined`. A different ID for an
existing conversation is refused. This lets the sender sign the conversation ID before sending
the bundle. `talk-start` carries `"format": 2`, `conversationId`,
and the bundle in `e2ee`; the relay passes the bundle to listeners in `burst-start` (`format`,
`e2ee`), wherever it sends one: live, replayed, resumed, and in `GET /v2/rings/audio`.

```json
"e2ee": {
  "v": 1,
  "sender": { "deviceId": "…", "phoneCert": "<base64>", "deviceCert": "<base64>" },
  "keys": [{ "deviceId": "…", "keyId": "0123456789abcdef", "enc": "<32 bytes>", "ct": "<48 bytes>" }],
  "sentAt": 1791399595000,
  "sig": "<64 bytes>"
}
```

- `keys`: one entry for each of the listener's devices the sender could seal to: HPKE of the
  message key to that device's encryption key, with info `str("oao-message-key-v1")`,
  `str(burstId)`, `str(deviceId)`, `str(keyId)`. `enc` is HPKE's encapsulated key.
- `sentAt`: the sender's clock when it made the bundle.
- `sig`: the sender device's signing key over `str("oao-bundle-v1")`, `str(conversationId)`,
  `str(burstId)`, `u8(2)`, `str(codec)`, `u64(sentAt)`, `str(sender's userId)`,
  `str(sender's deviceId)`, `str(listener's userId)`, `u16(number of keys)`, then for each
  entry in order `str(deviceId)`, `str(keyId)`, `bytes(enc)`, `bytes(ct)`.

A listener's device opens it in this order, refusing with the first failure that applies (the
names are the same on every platform, and in telemetry):

1. `v` is 1, else `bad-bundle`.
2. The phone certificate checks out and is the sender's account; the device certificate was
   issued by it and is `sender.deviceId`. Else `bad-certificate`.
3. The signature checks out with the device certificate's signing key, else `bad-signature`.
4. `sentAt` is at most 180,000 ms before this device's clock (`too-old`) and at most 60,000 ms
   after it (`from-the-future`).
5. There's an entry for this device, with a key ID it holds (its current key or the previous
   one), else `no-key`.
6. HPKE opens it to 32 bytes, else `decrypt`.

The sender's phone identity key is then compared with the ones this device has seen for that
friend; a new one is shown as "security code changed", and doesn't stop the message.

**Keys stale.** If a bundle has no entry, or an old key ID, for a device of the listener that has
current keys, the relay refuses the floor: `talk-refused` with `reason: "keys-stale"` and the
listener's current keys in `keys` (the same shape as the friends list). The client checks them
as above, seals again and retries.

### Frames

The same header as format 1; the payload is encrypted:

```
byte 0      codec, as format 1
bytes 1..4  sequence number, uint32 big-endian, as format 1
bytes 5..   ChaCha20-Poly1305 ciphertext of the payload, then its 16-byte tag
```

- Key: HKDF-SHA256 of the message key, no salt, info `"oao-frames-v1"` (bytes, not a `str`), 32
  bytes.
- Nonce: 8 zero bytes, then the sequence number (uint32 big-endian).
- Additional data: `0x02`, the codec byte, the sequence number (uint32 big-endian), then the
  burst ID's UTF-8 bytes.
- Valid sizes: an Opus payload of 17–1291 bytes (1–1275 encrypted, plus the tag), a PCM payload
  of exactly 656.
- A frame that doesn't decrypt is dropped, like a malformed one.

## The iPhone and its watch

Over WatchConnectivity, every message carries `schemaVersion: 2`:

- watch → phone: `{request: "session", deviceId, requestId, signingKey, schemaVersion}`; a
  watch signed in without E2EE certificates (signed in before E2EE) asks only for them,
  `{request: "keys", deviceId, keysFor: <its account ID>, signingKey, schemaVersion}`;
  application context `{deviceId, needsSession, keysFor?, signingKey, schemaVersion}`;
- phone → watch: `{session: <data>, phoneCert, deviceCert, schemaVersion}` (the session's JSON,
  with `parentDeviceId` and `clientKind`), or, for a keys request from the same account,
  `{phoneCert, deviceCert, schemaVersion}` with no new session (a new one would end the
  watch's current session while its requests are in flight); or `{signedOut: true,
  schemaVersion}`; context `{signedIn, schemaVersion}`.

A message without `schemaVersion` comes from a tester build before Phase 0: the phone still
answers it, and the watch still adopts a session from it. A session reply for another device
ID, or one that arrives after the phone signed out, is ignored.

The watch notification extension's prefetch metadata carries `schemaVersion: 2`, `ringId`,
`userId` and `expiresAt`; the app plays prefetched audio only for the same account, the same
ring and before `expiresAt`.

## Timing (initial product values)

| What | Value |
| --- | --- |
| Unanswered ring | 35 s from the first push |
| Answer → join grace | 30 s, started only by an answer before the deadline |
| Roll Over to iPhone | 12 s after the watch's push |
| Conversation idle (clients) | 45 s |
| Resume after a dropped stream | 30 s |
| Session check at the relay | at most 10 s old |
| Friendship check during a conversation | at most 10 s old |
