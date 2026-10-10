# App Store product page copy

Draft for the public launch, assuming end-to-end encryption of all voice messages is enforced.
Do not enter this copy in App Store Connect until that is verified on devices and the privacy
policy and App Privacy answers describe the same behavior.
The 256-bit claim refers to the key used for ChaCha20-Poly1305 audio encryption, not AES-256.
The relay cannot decrypt friend-to-friend audio in normal operation: it does not hold either
friend's private device keys. The service controls the public-key directory and could falsely
list a separate phone identity whose private key it owns. Do not claim that the servers are
incapable of listening under every circumstance. The server-side Test Bot decrypts messages
addressed to it by design.
"By default" and "no unencrypted mode" rely on E2EE PR D (format 1 refused everywhere) being
deployed. "Its own keys" for the watch relies on PR C: the watch registers its own device keys
and every message is sealed to each of the friend's registered devices.
## App name (28/30 characters)

Nowza: Walkie Talkie + Watch

Renamed from Over&Out on 2026-10-09 (an earlier app, "Over-N-Out Walkie Talkie", has a
confusingly similar name). Keep "Walkie Talkie" as two words: App Store search matches whole
words. The keyword list doesn't repeat any word in the name or subtitle. Recheck that if either
changes. `phone` is in the keywords because the name has no room for it.

## Subtitle (23/30 characters)

Every message encrypted

## Promotional text (166/170 characters)

Talk to friends and fam from Apple Watch or iPhone. Every message is end-to-end encrypted by default, all the way to your wrist. Your private keys stay on your devices.

## Description

Nowza is a walkie-talkie for close friends on Apple Watch and iPhone, and every message is end-to-end encrypted by default, on your watch as well as your phone. Hold the mascot's mouth to talk, then let go to listen. Ask a quick question, share a bit of news, or just say hi. Your friend can answer right back, and you can keep talking for as long as you like.

Here's how it works:

• Every message encrypted, by default. There's nothing to turn on and no unencrypted mode. A fresh 256-bit key protects each message between friends. Your private keys stay on your devices, so our relay cannot decode the encrypted audio it carries.

• Encrypted all the way to your wrist. Your Apple Watch has its own keys. Each message is encrypted separately for each of your friend's devices, so their watch decrypts it itself. It isn't decrypted on a phone or a server along the way.

• Talk from your watch. When a friend starts a conversation, your watch taps your wrist. Tap the ring to hear the message, even if Nowza was closed. Hold the mascot's mouth to answer. You can also start a conversation from a friend's Talk screen on your watch.

• Hear them on your iPhone. With iPhone ringing on, your friend's voice plays without a tap, even if the phone is locked or Nowza isn't open. Reply with the Talk button on the Lock Screen, or talk from the app. An Apple Watch isn't required.

• Choose where friends reach you. If you have a paired watch, set it to ring on your watch, on your iPhone, or on your watch first. In that last setting, your iPhone rings if you haven't answered the watch within 20 seconds.

• Invite the people you want to hear from. Send a link through Messages. They choose whether to add you, and only accepted friends can ring you. You can block or report someone if you need to.

Pick a screen name and a picture your friends will recognize: your own photo or one of Nowza's 19 mascots. They'll see it when you ring. Nowza doesn't keep recordings or a message history.

Start on your iPhone with Sign in with Apple. If you have an Apple Watch, install Nowza on it and it signs in from your iPhone.

## Keywords

phone,ptt,push,intercom,radio,conversation,friend,lock screen,two way,live,e2ee,private,secure,chat
