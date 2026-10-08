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
| A malicious server (same day, after a review of man-in-the-middle attacks) | Close replays (a signed send time, no sequence played twice); senders refuse expired encryption keys; signing in again to the same account keeps the phone's identity key, so notices stay rare; a message from a just-changed key is marked while it plays; the inviter's key fingerprint goes in the invite link. Key changes don't block yet; blocking and key transparency are kept under "Later" |

## What it protects, and what it doesn't

Protected: the audio of every message, live or held, against the relay, Google Cloud, and anyone
who can read relay memory or traffic past TLS. It also protects against a server that injects
audio claiming to come from a friend's known devices (each message is signed by the sending
device), or that replays a real message later (see "The server as attacker").

Not protected:
- **Metadata:** who rings whom, when, how long, which devices, and burst lengths. The service
  needs these to ring and route.
- **Packet sizes:** Opus is variable-bitrate by default, and research on VBR voice over
  encrypted links has shown phrases can sometimes be spotted from packet sizes. Constant
  bitrate mostly closes this (see "Opus at a constant bitrate").
- **A malicious directory, until someone verifies:** the server could list a key it controls for
  a friend. The "security code changed" notice is how people notice; the invite link's
  fingerprint covers the first contact for invites; verification codes (phase 2) are how they
  check. "The server as attacker" goes through each case.
- **The devices themselves.** A compromised or unlocked device can hear what it plays.

## Cryptography

Everything is in the platforms' own libraries: CryptoKit on iOS 17 and watchOS 10 (HPKE arrived
in those releases, which are our minimums), Tink or BoringSSL on Android later, and node:crypto
on the server (for the Test Bot and the shared test vectors). Node has no HPKE, so
`server/src/e2ee.ts` builds it from node:crypto's X25519, HMAC-SHA256 and ChaCha20-Poly1305 and
checks it against RFC 9180's published vectors; the server keeps no dependencies.

The exact byte layouts are in [contracts/README.md](contracts/README.md), "End-to-end encryption".

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
| **Device encryption key** (X25519) | each device | the device signing key (an *encryption key certificate*, with a key ID, `issuedAt` and `notAfter` = 30 days later) | rotated weekly |

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
- **Rotation:** each device makes a new encryption key weekly (when the app, or on the watch the
  notification extension, runs and the current one is 7 days old) and uploads its certificate.
  It keeps the previous private key for 7 days for senders with a stale cache, then deletes it.
  That bounds what a stolen device key can decrypt from recorded traffic to about two weeks.
- **Expiry:** a sender seals only to the newest unexpired encryption key certificate it has for
  each device, and never to one past `notAfter`. A device none of whose certificates are current
  is left out of the bundle; if that leaves none of the friend's devices, Talk fails with "Can't
  reach Steve right now" and an `e2eeFailed` (`no-current-key`) event. The 30 days keep a device
  that's rarely opened reachable, while stopping a server from pushing an old key (perhaps
  stolen from a device) back into use after that.
- **Sign-out** deletes the device's signing and encryption keys. On a phone, the identity key
  stays in the Keychain, filed under the account ID, so signing in again to the **same account**
  on the same phone keeps it: new device keys under the same identity, and no notice for
  friends. It's deleted when a **different account** signs in on that phone, when the account
  is deleted, and with the app's data. Routine notices would teach people to ignore the ones
  that matter. Revoked watches delete their keys on `session-ended`; the iPhone certifies them
  again at the next sign-in. The server drops a device's certificates with its registration, on
  revocation, and on account deletion.

## Messages

Each message (burst) gets its own random 32-byte **message key**.

### Key bundle

At `talk-start` the sender attaches a bundle:

```json
"e2ee": {
  "v": 1,
  "sender": { "deviceId": "…", "phoneCert": "<b64>", "deviceCert": "<b64>" },
  "keys": [ { "deviceId": "…", "keyId": "…", "enc": "<b64>", "ct": "<b64>" } ],
  "sentAt": 1791331200000,
  "sig": "<b64>"
}
```

- `keys` has one entry for **every** device of the friend that has an encryption key, not just
  the one that will ring: the ring may roll over to the iPhone, fall back, or the conversation
  may move to another device. Each entry is the message key sealed with HPKE to that device's
  current encryption key. The HPKE `info` binds the format version and the burst ID.
- `sentAt` is the sender device's clock (ms) when it built the bundle.
- `sig` is the sender device's signature over the conversation ID, burst ID, codec, `sentAt`,
  sender and recipient account IDs, and every `keys` entry. It stops the relay from moving a
  message to another conversation, relabelling it with another burst ID or time, sending it
  back to its sender, or swapping keys.
- **Replays:** a listener plays a message only if `sentAt` is at most about 3 minutes old by its
  own clock: the longest a real message waits before its start is heard (a 35 s ring, a 30 s
  join grace, queued bursts of up to 60 s, and a 30 s resume), plus a minute for clock drift:
  180 s, and at most 60 s in the future (PR A). Within that window each device remembers, for 10 minutes, every
  burst ID and sequence number it has played, and never plays one again. That's the same rule
  the playback ledger already follows for prefetched frames the relay replays, so prefetch,
  replays and resumes still work. A message older than the limit, or played already, is dropped
  with an `e2eeFailed` event (`replayed`). Inside the window, the same message can still play on
  another of the listener's devices, as a rollover or a moved conversation legitimately does.
- `sender` carries the sender's certificate chain, so a listener checks the bundle with nothing
  but the friend's phone identity keys, which it has cached since they became friends. **No key
  is fetched on the ring path.** If the chain ends at a phone key the listener hasn't seen (the
  friend's new phone, a cache older than the change), it plays the message, records the
  "security code changed" notice, and refreshes the friend's keys in the background.

A bundle is about 1.2 KB of JSON for a friend with two devices (the test vectors' 1,172 bytes):
about 150 bytes per device, and the rest the sender's two certificates and the signature.

### Frames: binary audio format 2

```
byte 0      codec (unchanged: 1 = opus16k, 2 = pcm16le16k)
bytes 1..4  sequence number, uint32 big-endian (unchanged)
bytes 5..   ChaCha20-Poly1305(frame key, nonce = 8 zero bytes ‖ seq, aad = 0x02 ‖ codec ‖ seq ‖ burstId)
            = the codec payload, then a 16-byte tag
```

- The frame key is HKDF-SHA256 of the message key (info "oao-frames-v1"), so the message key
  itself is only ever used once, inside HPKE.

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

## The server as attacker

Someone between a device and the relay faces TLS and this encryption both, and gains nothing.
The real man-in-the-middle is whoever controls the server (us, a bad deploy, an intruder in the
relay or the API, or a legal demand), because the server is the key directory. What they can do
with this design:

| Attack | Outcome |
| --- | --- |
| List their own phone key for Steve before Helen's app has ever seen Steve's | Works, unseen, unless Helen became Steve's friend through his invite link (the fingerprint catches it) or they verify codes later (phase 2) |
| Add a phone of their own to Steve's devices later, so Helen's messages are sealed to it too | Helen sees "Steve's security code changed". Not blocked |
| Add a watch of their own under Steve's real phone | Fails: only Steve's phone can certify his watches |
| Substitute an encryption key | Fails: each is signed by its device |
| Push an old encryption key back into use (perhaps stolen) | Fails after the certificate's 30 days. Before that, the sender still prefers the newest certificate it has seen |
| Send audio as Steve, signed by a phone of their own | Plays, marked as from a just-changed key, after the notice |
| Replay one of Steve's real messages later, or play it twice | Fails: the signed `sentAt` limits its age, and a device never plays a burst's sequence numbers twice |
| Move a message to another conversation, to another friend, or back to its sender | Fails: the signature covers the conversation, both accounts and the burst |
| Force plaintext | Only during the rollout, and only for a friend whose keys a device hasn't seen yet. Format 1 is refused everywhere after PR D |
| Interfere when the watch hands its key to the iPhone | Not exposed: that goes over Apple's paired-watch link, not our server |
| Listen to the Test Bot | Yes, by design: the server holds the bot's keys. Nobody's real conversations go through it |

So, until phase 2, a malicious server can still listen by adding a phone key, but not without
the friend's app showing a notice, except at a first contact that didn't come from an invite
link. Nothing cryptographic stops it; people notice it. "Later" lists the two ideas that would
close it further.

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
  `deviceCert` and the iPhone's `phoneCert` (the watch puts both in its bundles). Optional
  fields under `schemaVersion: 2`.

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

`VoiceCodec` asked for 24 kbps from `AVAudioConverter`, leaving the bitrate strategy at its
default (variable). PR 0 sets `bitRateStrategy` to `AVAudioBitRateStrategy_Constant`. That needs
no E2EE and ships on its own. If Apple's Opus encoder ignored it on some device, format 2 would
pad inside the ciphertext to a fixed size per codec (a length prefix plus zeros), at the cost of
a few bytes per frame.

Measured 2026-10-07 (branch `opus-cbr`):
- **macOS encoder**, 250 frames of silence, a sweeping tone, noise and near-silence: variable
  (the old default) gave 8–107 bytes, 38 distinct sizes, silence always 8 bytes;
  long-term-average and variable-constrained the same; constant gave 60 bytes for every packet.
- **watchOS 27 simulator** → local relay → bot: a 4.5 s burst of the test tone, 227 frames,
  `burstLevelSent` `bytes=60-60`.
- **Still to check on devices** (TestFlight): real speech on the watch and the iPhone gives
  `bytes=60-60`, and the voice sounds no worse. Pauses now cost 60 bytes a frame instead of 8.

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
  once: "Steve's security code changed. This happens when they sign in on a new iPhone." For a
  day after the change, the Talk screen also marks each message from the new key while it plays
  (a small mark by the friend's name, on the watch and the iPhone), because a notice seen once
  is easy to miss. It never blocks a message.
- **Invite fingerprint:** an invite link carries the inviter's phone key fingerprint in its
  fragment, `overandout.app/i/<code>#k=<fingerprint>`. Browsers and universal links don't send
  the fragment to the server, and most invites travel by Messages or email, which our server
  doesn't carry. When the link is accepted, the app checks that the inviter's keys from the
  directory include that key. If they don't, the friendship still forms, but the friend's page
  says "Couldn't confirm Steve's security code" until a later check passes (phase 2). This
  covers the invitee's first sight of the inviter, not the reverse; the inviter has no channel
  back that skips the server. The invite web page must keep the fragment when it hands the link
  to the app.
- **Downgrade:** once a device has seen keys for a friend, it never sends format 1 to that friend
  and never plays format 1 from them (it drops the message and logs it). After the cutover,
  format 1 is refused everywhere.
- **Telemetry** (on the device timeline; never keys or key material): `bundleSealed` with the
  time it took, `bundleOpened` with the time it took (between burst start and first audio, so
  run analysis shows the cost), `e2eeFailed` with a reason (`bad-signature`, `no-key`,
  `stale-key`, `no-current-key`, `decrypt`, `downgrade`, `replayed`), `keysRotated`, and
  `keyChanged` (a friend's phone keys changed; the friend's account ID, never the keys).

## Rollout

The same shape as Phase 0. Nothing about it works partially, so it goes in before the App
Store launch while every tester can be told to update.

1. **PR 0: constant-bitrate Opus.** Independent; check the packet sizes, then re-measure tap →
   first audio and push → first audio.
2. **PR A: contract and crypto.** `contracts/` (format 2, the bundle, certificates, the
   signed-byte layouts, `keys-stale`), shared test vectors in `contracts/fixtures` (checked by
   `ContractTests.swift` and `contracts.test.ts`), the kit's `E2EE` module and its tests, and the
   server's crypto helper. No change in behaviour. Built 2026-10-07 on branch `e2ee-crypto`.
3. **PR B: server.** Key registration, keys in the friends list, the relay's format 2
   pass-through, bundles in `burst-start` and the prefetch, `keys-stale`, the Test Bot and the
   Canary, and the perf budgets. Format 1 still works, so it can deploy before the apps (deploy
   with Steve's OK).
4. **PR C: apps.** Keys, the watch link, sealing and opening, replay checks, the extension, the
   notice and the playing mark, rotation, the invite fingerprint (the apps, and the invite page
   in `web/public` keeping the fragment; a website deploy with Steve's OK), and telemetry. A build sends format 2 to a friend once every device of theirs has
   keys, and format 1 otherwise. Simulators on a local relay, then a TestFlight build (ask
   first), then device runs.
5. **PR D: enforcement.** Raise `minimumBuilds` to that build, refuse format 1 in the relay and
   the apps, drop format 1 from `/v2/config`, update the privacy policy and support page, and
   answer export compliance again. Deploys and App Store Connect changes need Steve.

## Testing

- **Kit and server:** the shared vectors; round trips; tampering (each field of the bundle, a
  frame's codec, sequence, burst or `sentAt`), the wrong device, an expired encryption key (not
  sealed to; the friend's only device expired gives `no-current-key`), the previous key within
  the grace, an unknown phone key (plays, flags the notice and the mark), format 1 from a friend
  with keys (dropped), a message replayed after the age limit and a sequence played twice
  (both dropped), and a prefetched message the relay then replays (plays once).
- **Sign-in again:** the same account on the same phone keeps the identity key (no notice for
  friends); a different account deletes it.
- **Invite fingerprint:** a matching key, a different key (the warning), and a link without a
  fragment (as today), through the universal link and through the invite web page.
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
friend's page; a failed invite fingerprint check is cleared by verifying; after verifying, a
later key change asks to verify again instead of only noting it.

## Later (ideas kept, not planned)

- **Holding messages from a changed key** (Steve, 2026-10-07: not now). Instead of playing a
  message from a friend's new phone key with a mark, hold it until the listener accepts the
  change ("Steve has a new iPhone. Play?"). Safer against a server adding a phone, but every
  new phone delays the first message after it, and a tap on the watch to accept becomes part of
  the ring path. Phase 2 already blocks key changes for friends who verified each other; this
  would extend it to everyone.
- **Key transparency.** Publish every account's phone keys to a public, append-only log (a
  Merkle tree, as in CONIKS, Google's Key Transparency, WhatsApp's and Apple's iMessage
  Contact Key Verification). Each app checks that the keys it's given for a friend, and its own
  keys, are in the log as everyone else sees it, so a server can't show one person a key it
  hides from the key's owner. Needs an independent auditor or witnesses to mean much, and new
  hosting; worth it only at scale.

### Maybe: server impersonation (reviewed 2026-10-07)

Steve asked whether someone could pose as our servers, for example with a DNS hack on the
client. All of this is a possible future step, not planned.

**What protects us today.** Release builds talk only to `https://relay-1.overandout.app` and
`https://overandout.app` (plain HTTP only for localhost, in the simulator). No code overrides the
system's certificate checks, and the service can point apps only at HTTPS hosts under
overandout.app (`ServiceConfigStore.approved`). So a DNS hack on the client, such as rogue Wi-Fi
or a poisoned resolver, only stops the app connecting: the attacker can't show a valid
certificate. Nothing is pinned, though: any certificate from a CA the device trusts is
accepted.

**What would work:**

| Attack | Likelihood | Why it works |
| --- | --- | --- |
| Taking over our real DNS (the GoDaddy account or the registrar) | The realistic "DNS hack" | Whoever controls the zone can pass a CA's ownership check and get a valid certificate |
| A wrongly issued certificate from any trusted CA | Rare | Nothing is pinned |
| A root certificate installed on the device (company TLS inspection, MDM, a profile someone was tricked into) | Targeted | iOS trusts roots the user has enabled |

**What an impersonator gets.** Before E2EE: all audio, the ability to inject it, friends lists,
and **session tokens**. Those are bearer tokens (30 days, refreshable for a year), so the
attacker can use the real service as that person afterwards. With E2EE: no more than the
malicious server above, but stolen tokens still matter. A phone's token could register the
attacker's own phone key for that device, which friends would see only as "security code
changed".

**Possible mitigations**, roughly by value for effort:
1. **DNS hygiene** (Steve, at GoDaddy): a hardware-key second factor on the account, registrar
   lock, DNSSEC.
2. **CAA records** that allow only the CAs we use: Google Trust Services for the relay's
   Caddy (`setup-relay.sh`); Firebase Hosting's CA to be checked. Optionally RFC 8657's
   `accounturi`, which ties issuance to our own ACME account.
3. **Certificate Transparency monitoring** for overandout.app: free services alert on any new
   certificate, so a wrongly issued one shows up within hours.
4. **Sessions bound to a device key:** each request signed with the device's signing key
   (E2EE gives every device one), so a captured token alone is useless.
5. **Certificate pinning** in the apps: pin CA keys with a backup, not the server's own
   certificate. It defeats wrongly issued certificates and installed roots. But a CA change
   could lock every installed app out until an update ships, and it breaks people behind
   company TLS inspection. Last, if at all.

## Open questions

1. Does Apple's Opus encoder honour constant bitrate? (PR 0 answers it.)
2. ~~Which RFC 9180 package for Node?~~ None: built from node:crypto and checked against the
   RFC's vectors (PR A).
3. The Secret Manager secret for the Test Bot's keys (Steve's OK).
4. Export compliance answers (before PR D).
5. Does the universal link hand the app the URL with its fragment, and can the invite web page
   keep it through the TestFlight or App Store install for someone without the app?
6. ~~The exact replay age limit?~~ 180 s old, 60 s ahead (PR A).

## What needs Steve

The Test Bot's secret; the relay and API deploys (PR B, then PR D); each TestFlight upload; the
device runs; the minimum build and format 1's retirement; the website deploy for the privacy
policy; and the App Store Connect export compliance answers.
