# Over&Out end-to-end encryption: spec

Oct 7, 2026 · Steve Teixeira

A plan, not yet built. Nothing in the apps, the relay or the API has changed for it.

## Summary

Messages are encrypted on the speaker's device and decrypted only on the listener's devices. The
relay keeps routing, holding, replaying and resuming them, but it handles ciphertext it can't
read. The relay never needs plaintext audio: it reads only each frame's codec byte and sequence
number, which stay readable. The one server-side component that decodes audio is the Test Bot,
which becomes an endpoint with its own keys.

Today TLS ends at Caddy on the relay VM, so audio is plaintext in the relay's memory while it's
live, while a ring is held (up to 35 s), and for the 30 s resume window. Anyone with access to
the relay could listen: a compromised VM, a bad deploy, Google, or a legal demand. With this
change they can't, and the privacy policy can say we *can't* hear messages, not only that we
don't. Apple's Walkie-Talkie ran over FaceTime, which is end-to-end encrypted, so this also
matches the app we replace.

Decided with Steve on 2026-10-07:

| Question | Decision |
| --- | --- |
| Scope | Audio only. Names, mascots, photos, the friends list and the push payload's `fromName` stay as they are |
| Trust model | The server is the key directory. Each device remembers a friend's keys the first time it sees them and shows a non-blocking "security code changed" notice when they change. Verification codes come later (phase 2) |
| Forward secrecy | Device encryption keys rotate weekly; old private keys are deleted after a 7-day grace |
| Packet-size leak | Try constant-bitrate Opus; pad inside the ciphertext only if Apple's encoder won't do CBR |
| Timing | Before the App Store launch, as a forced update like Phase 0, so no plaintext fallback outlives the beta |

## What it protects, and what it doesn't

Protected: the audio of every message, live or held, against the relay, Google Cloud, and anyone
who can read relay memory or traffic past TLS. It also protects against a server that injects
audio claiming to come from a friend (each message is signed by the sending device).

Not protected:
- **Metadata:** who rings whom, when, how long, which devices, and burst lengths. The service
  needs these to ring and route.
- **Packet sizes:** Opus is variable-bitrate by default, and research on VBR voice over
  encrypted links has shown phrases can sometimes be spotted from packet sizes. Constant
  bitrate mostly closes this (see "Opus at a constant bitrate").
- **A malicious directory, until someone verifies:** the server could list a key it controls for
  a friend. The "security code changed" notice is how people notice; verification codes (phase
  2) are how they check.
- **The devices themselves.** A compromised or unlocked device can hear what it plays.

## Cryptography

Everything is in the platforms' own libraries: CryptoKit on iOS 17 and watchOS 10 (HPKE arrived
in those releases, which are our minimums), Tink or BoringSSL on Android later, and node:crypto
plus a vetted RFC 9180 package on the server (for the Test Bot and the shared test vectors).

| Use | Algorithm |
| --- | --- |
| Signing (phone identity, device keys, message bundles) | Ed25519 |
| Sealing a message key to a device | HPKE, RFC 9180, base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305 |
| Frames | ChaCha20-Poly1305 with the message key |
| Fingerprints | SHA-256 |

ChaCha20-Poly1305 rather than AES-GCM because it's fast in software on watches without AES
instructions (relevant for Wear OS); Apple devices handle either.

Signatures, not HPKE's auth mode, give sender authentication: Ed25519 is everywhere, while HPKE
auth mode isn't in every Android library's public API.

Signed byte strings are a fixed context string followed by length-prefixed fields (never JSON),
so every platform signs and checks the same bytes. The exact layouts go in the contract with
test vectors.

## Keys

| Key | Where it lives | Signed by | Lifetime |
| --- | --- | --- | --- |
| **Phone identity key** (Ed25519) | each phone (iPhone, later Android) | itself | until sign-out on that phone |
| **Device signing key** (Ed25519) | each device: the phone and each of its watches | the phone identity key (a *device certificate*) | until sign-out or revocation |
| **Device encryption key** (X25519) | each device | the device signing key (an *encryption key certificate*, with a key ID and `notAfter`) | rotated weekly |

- **A phone identity per phone, not per account.** Accounts can have more than one phone, and
  no key has to be copied between them. A friend's "security code" covers the set of their
  phone identity keys. A new phone key (a new iPhone, or signing in again) causes the notice; a
  new watch under a known phone doesn't.
- **Watches never see the phone's identity key.** The watch makes its own signing key and sends
  the public half to the iPhone over WatchConnectivity with its session request; the iPhone
  returns a device certificate with the session. This extends the companion-session flow the
  iPhone already runs (`PhoneWatchLink.swift`, the contract's "The iPhone and its watch").
  Android and Wear OS work the same way.
- **Storage:** the Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, as the session
  token is today (`KeychainSessionStore`). A locked iPhone can then play a PushToTalk message,
  and on the watch the keys go under the app group's access group, so the notification service
  extension can read them for the prefetch. Not synced through iCloud Keychain: a new iPhone
  means a new identity and a notice to friends.
- **Rotation:** each device makes a new encryption key weekly (at launch or on coming to the
  foreground when the current one is 7 days old) and uploads its certificate. It keeps the
  previous private key for 7 days for senders with a stale cache, then deletes it. That bounds
  what a stolen device key can decrypt from recorded traffic to about two weeks.
- **Sign-out** deletes all of the device's private keys. Signing out on a phone also deletes its
  identity key; its watches' certificates are then worthless, as their sessions already are.
  The server drops a device's certificates with its registration, on revocation, and on account
  deletion.

## Messages

Each message (burst) gets its own random 32-byte **message key**.

### Key bundle

At `talk-start` the sender attaches a bundle:

```json
"e2ee": {
  "v": 1,
  "sender": { "deviceId": "…", "deviceCert": "<b64>", "phoneCert": "<b64>", "encCert": "<b64>" },
  "keys": [ { "deviceId": "…", "keyId": "…", "enc": "<b64>", "ct": "<b64>" } ],
  "sig": "<b64>"
}
```

- `keys` has one entry for **every** device of the friend that has an encryption key, not just
  the one that will ring: the ring may roll over to the iPhone, fall back, or the conversation
  may move to another device. Each entry is the message key sealed with HPKE to that device's
  current encryption key. The HPKE `info` binds the format version and the burst ID.
- `sig` is the sender device's signature over the conversation ID, burst ID, codec, sender and
  recipient account IDs, and every `keys` entry. It stops the relay from moving a message to
  another conversation, replaying it under another burst ID, or swapping keys.
- `sender` carries the sender's certificate chain, so a listener checks the bundle with nothing
  but the friend's phone identity keys, which it has cached since they became friends. **No key
  is fetched on the ring path.** If the chain ends at a phone key the listener hasn't seen (the
  friend's new phone, a cache older than the change), it plays the message, records the
  "security code changed" notice, and refreshes the friend's keys in the background.

A bundle is about 150 bytes per recipient device plus about 400 bytes of certificates and
signature.

### Frames: binary audio format 2

```
byte 0      codec (unchanged: 1 = opus16k, 2 = pcm16le16k)
bytes 1..4  sequence number, uint32 big-endian (unchanged)
bytes 5..   ChaCha20-Poly1305(message key, nonce = 8 zero bytes ‖ seq, aad = 0x02 ‖ codec ‖ seq ‖ burstId)
            = the codec payload, then a 16-byte tag
```

- The codec and sequence stay readable for codec enforcement, replay and resume, but they're
  authenticated. A frame moved to another position or burst fails to decrypt.
- Valid sizes: Opus payload 17–1291 bytes, PCM exactly 656.
- At 24 kbps a frame grows from 65 to 81 bytes: about 6.4 kbps more per stream.
- Per contract rule 6 this is a new format, not a header on format 1. A burst names its format at
  `talk-start` (`format: 2`), as it names its codec.

### Listening

On `burst-start` (live, replayed, resumed, or in the prefetch records) the listener checks the
chain and the signature, opens its own `keys` entry with its current or previous encryption
key, then decrypts frames as they come. The cost is one signature chain check and one HPKE open
per message, a few milliseconds, plus microseconds per frame. A frame that fails to decrypt is
dropped like a malformed one.

### Sending without delay

The sender can build the next message's bundle as soon as the Talk screen opens, so the first
press still talks at once. Sealing to 2–3 devices and one signature takes a few milliseconds even
so.

## Relay and API changes

The relay passes ciphertext through. Specifically:

- **Admission and capabilities:** `audioFormats: [1, 2]` in `/v2/config` and device
  capabilities while both are allowed, then `[2]`.
- **`talk-start`:** takes `format` and `e2ee`. The relay checks that the bundle has an entry for
  every device of the recipient with registered encryption keys, at the current key ID (or the
  previous one within the grace). If not, it refuses with `talk-refused`, reason `keys-stale`,
  plus the recipient's current certificates. The client checks them against the friend's
  phone keys, seals again and retries at once. That costs one round trip, and only when the
  cache was stale. The relay checks nothing cryptographic: it couldn't, and needn't.
- **`burst-start`:** carries the whole bundle, wherever it's sent today: live, replays,
  resumed bursts, and the `GET /v2/rings/audio` records the watch's extension prefetches. The
  listener needs the whole `keys` list to check the signature, and it holds only device IDs and
  sealed keys.
- **Frames:** `isValidFrame` takes the format, and the held-audio limits count the larger
  frames.
- **`PUT /v2/me/device`:** takes `e2ee: {phoneCert?, deviceCert, encCert}`. The server checks
  the signatures fit together (cheap, and it catches client bugs), not who made them.
- **`GET /v2/friends`:** each friend gains `keys: {phones: [phoneCert], devices: [{deviceId,
  clientKind, deviceCert, encCert}]}`. Friends can then see each other's device kinds (whether a
  friend has a watch); the privacy policy says so.
- **Storage:** the certificates go on the device record in Firestore; no new collections. No new
  billed resources.
- **Watch link:** the watch's session request gains `signingKey`; the iPhone's reply gains
  `deviceCert`. Both are optional fields under `schemaVersion: 2`.

## The Test Bot, the Canary and the tools

- **Test Bot** (inside the relay, `test-bot.ts`): it has its own phone identity and device keys.
  It opens what friends send it and seals its echo and greeting to their devices. The keys must
  survive node replacement, or every tester sees "Test Bot's security code changed" each month:
  production keeps them in a Secret Manager secret (ask Steve first), and local runs keep them
  in `DATA_DIR`.
- **Canary** (the rolling job): makes fresh keys each run and registers them with its device.
  Its pass still measures talk-start → the bot's first frame, now including the crypto.
- **`bot.ts`, `client.ts`, `test-account.ts`:** keys beside their token files.
- **Perf suite:** synthetic clients send format 2 with random bytes for keys and ciphertext (the
  relay doesn't decrypt). Byte budgets go up for the bundle and the tags.

## Opus at a constant bitrate

`VoiceCodec` asks for 24 kbps from `AVAudioConverter`, leaving the bitrate strategy at its
default. First step: set `bitRateStrategy` to `AVAudioBitRateStrategy_Constant` and check, in the
simulator and on the watch, that every packet is the same size (60 bytes at 24 kbps). That needs
no E2EE and can ship on its own. If Apple's Opus encoder ignores it, format 2 pads inside the
ciphertext to a fixed size per codec (a length prefix plus zeros), at the cost of a few bytes per
frame.

## The apps

- **Kit:** an `E2EE` module: key generation and storage, certificates, bundle sealing and
  checking, frame encryption, and a cache of friends' keys with the friends list. Swift 6
  language mode; value types and `Sendable`.
- **iPhone:** creates its identity key at sign-in (and for existing accounts at the first launch
  of the new build); issues watch certificates; seals and opens; rotates keys. PushToTalk
  playback while locked works because the keys are after-first-unlock.
- **Watch:** creates its keys and gets its certificate over the link. If the iPhone isn't
  reachable yet, it can't send or hear encrypted messages; it says "Open Over&Out on your
  iPhone" (like the existing session path).
- **Watch notification extension:** downloads the prefetch as today and keeps it encrypted on
  disk. The app opens it at the tap, so plaintext never touches the disk.
- **Notice:** when a friend's phone keys change, the friend's page and the Talk screen show
  once: "Steve's security code changed. This happens when they sign in on a new iPhone." It
  never blocks a message.
- **Downgrade:** once a device has seen keys for a friend, it never sends format 1 to that friend
  and never plays format 1 from them (it drops the message and logs it). After the cutover,
  format 1 is refused everywhere.
- **Telemetry** (on the device timeline; never keys or key material): `bundleSealed` with the
  time it took, `bundleOpened` with the time it took (between burst start and first audio, so
  run analysis shows the cost), `e2eeFailed` with a reason (`bad-signature`, `no-key`,
  `stale-key`, `decrypt`, `downgrade`), and `keysRotated`.

## Rollout

The same shape as Phase 0. Nothing about it works partially, so it goes in before the App
Store launch while every tester can be told to update.

1. **PR 0: constant-bitrate Opus.** Independent; check the packet sizes, then re-measure tap →
   first audio and push → first audio.
2. **PR A: contract and crypto.** `contracts/` (format 2, the bundle, certificates, the
   signed-byte layouts, `keys-stale`), shared test vectors in `contracts/fixtures` (checked by
   `ContractTests.swift` and `contracts.test.ts`), the kit's `E2EE` module and its tests, and the
   server's crypto helper. No change in behaviour.
3. **PR B: server.** Key registration, keys in the friends list, the relay's format 2
   pass-through, bundles in `burst-start` and the prefetch, `keys-stale`, the Test Bot and the
   Canary, and the perf budgets. Format 1 still works, so it can deploy before the apps (deploy
   with Steve's OK).
4. **PR C: apps.** Keys, the watch link, sealing and opening, the extension, the notice,
   rotation and telemetry. A build sends format 2 to a friend once every device of theirs has
   keys, and format 1 otherwise. Simulators on a local relay, then a TestFlight build (ask
   first), then device runs.
5. **PR D: enforcement.** Raise `minimumBuilds` to that build, refuse format 1 in the relay and
   the apps, drop format 1 from `/v2/config`, update the privacy policy and support page, and
   answer export compliance again. Deploys and App Store Connect changes need Steve.

## Testing

- **Kit and server:** the shared vectors; round trips; tampering (each field of the bundle, a
  frame's codec, sequence, or burst), the wrong device, an expired encryption key, the previous
  key within the grace, an unknown phone key (plays, flags the notice), and format 1 from a
  friend with keys (dropped).
- **Relay:** bundles reach live, replayed, resumed and prefetched listeners unchanged;
  `keys-stale` for a missing device and an old key ID; rollover to the iPhone opens with the
  iPhone's entry; a conversation moved to another device.
- **Simulators** (local relay with the API, as in HANDOFF's Simulator section): watch ↔ Test
  Bot, iPhone ↔ watch, the extension's prefetch played at the tap, a key rotation, a friend
  signing in again (the notice), and `keys-stale` after a friend adds a watch.
- **Devices** (TestFlight, without the debugger): re-measure watch tap → first audio (app
  closed with the extension, and in the app) and iPhone push → first audio (locked; check Ring
  Me On first), and a rollover to the iPhone. Each run's telemetry goes to the `run-analyst`
  subagent; `bundleOpened` shows the crypto's share. Target: at most 10 ms added at the median.

## Outside the code

- **Export compliance.** All three Info.plists say `ITSAppUsesNonExemptEncryption = NO`, and
  `asc.ts` checks the answer. Encrypting people's content changes it. Using only CryptoKit (the
  encryption in Apple's operating system) may keep the app out of the paperwork path, but check
  Apple's current questions and the US mass-market rules before PR D, and note that App Store
  Connect also asks about distribution in France. The Android app, which bundles its own
  crypto library, will need the same review.
- **Privacy policy and App Privacy label.** "Your voice" says the relay can't hear messages;
  the friends list now shares device kinds with friends. Review the App Privacy answers for
  audio.
- **Moderation.** Reports already carry IDs and notes, never audio, so nothing is lost. Sending a
  reported message as evidence would need message franking: later, if ever.

## Phase 2 (not planned yet)

Verification: a security code (a fingerprint over both people's phone keys) and a QR code on the
friend's page; the inviter's fingerprint in the invite link's fragment (`/i/<code>#k=…`, which
the server never sees; check that universal links keep the fragment); after verifying, a later
key change asks to verify again instead of only noting it.

## Open questions

1. Does Apple's Opus encoder honour constant bitrate? (PR 0 answers it.)
2. Which RFC 9180 package for Node, and is the Test Bot's HPKE checked against the RFC's
   vectors as well as ours?
3. The Secret Manager secret for the Test Bot's keys (Steve's OK).
4. Export compliance answers (before PR D).

## What needs Steve

The Test Bot's secret; the relay and API deploys (PR B, then PR D); each TestFlight upload; the
device runs; the minimum build and format 1's retirement; the website deploy for the privacy
policy; and the App Store Connect export compliance answers.
