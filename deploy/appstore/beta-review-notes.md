# TestFlight test information and Beta App Review notes

Draft for external TestFlight (backlog row "TestFlight test information and Beta App Review notes"). Steve enters these in App Store Connect → Over&Out → TestFlight → Test Information; the App Store review reuses the review notes. Fill in the bracketed values first.

The Test Bot parts assume the always-on Test Bot is deployed (`TEST_BOT_USER_ID` on the relay, `TEST_BOT_INVITE` on the API; branch with `server/src/test-bot.ts`).

## Test information

**Beta App Description** (up to 4,000 characters):

> Over&Out is a walkie-talkie for Apple Watch and iPhone. Hold the mascot's mouth to talk; your friend hears you on their watch or iPhone. On a watch, a ring taps your wrist and a tap plays the message. On an iPhone, messages play by themselves, even with the phone locked, and you can reply from the Lock Screen.
>
> Only friends you invite can reach you. Invite someone from the Friends screen and send the link over Messages.
>
> Please try: talking from your watch and from your iPhone; answering a ring on your watch with the app closed; replying from the iPhone's Lock Screen; Bluetooth headphones and hearing aids. Tell us if the start of a message is ever cut off, if a ring doesn't arrive, or if audio is delayed.

**Feedback Email:** support@cypressoakstudios.com

**Marketing URL:** https://overandout.app

**Privacy Policy URL:** https://overandout.app/privacy

## Beta App Review information

**Contact:** [first name] [last name], [phone], [email]

**Sign-in required:** Yes, with Sign in with Apple. There is no username or password; reviewers sign in with their own Apple ID. (App Store Connect asks for a demo account: leave it empty and say so in the notes, as below.)

**Review notes** (up to 4,000 characters):

> Over&Out is a walkie-talkie between friends, for iPhone and Apple Watch. Sign in with your own Apple ID (Sign in with Apple); there is no demo account because there is no password sign-in.
>
> TO TRY IT WITH OUR TEST BOT: you start with no friends, so we run an always-on "Test Bot" that answers. After signing in and finishing setup on the iPhone, paste this link into Notes or Messages and tap it (typing it into Safari's address bar won't open the app): https://overandout.app/i/[TEST_BOT_INVITE]. Tap Add. Open Test Bot's Talk screen (on the iPhone, or on the Apple Watch from its friends list), hold the mascot's mouth, say something, and let go. The bot answers, plays a short greeting, then plays back what you said, and does the same for each message after that. It only answers; it never calls you.
>
> PUSH TO TALK AND BACKGROUND AUDIO: on the iPhone the app uses the Push to Talk framework (PTChannelManager). Messages from friends arrive as Push to Talk pushes and play without a tap, including on the Lock Screen, where the system's Talk button lets you reply. The app also declares the "audio" background mode: without it the system won't activate a Push to Talk app's audio session in the background, so an incoming message can't play. Audio plays only while a friend is talking to you, and the microphone records only while you hold Talk (guideline 2.5.4).
>
> APPLE WATCH: the watch app signs in from the iPhone by itself. A friend's message rings the watch with a notification; tapping it plays the message. A notification service extension downloads the message while the notification is shown, so it plays at once.
>
> SAFETY AND ACCOUNTS: only people you've accepted as friends (through an invite link) can reach you. On a friend's page you can report them (with a reason, including an inappropriate profile photo) and block them; blocking ends any conversation with them at once. Settings → Delete Account deletes the account and its data and revokes the Sign in with Apple token.
>
> DATA: audio goes through our relay as you talk; if your friend hasn't answered yet, the relay holds the message in memory for up to about 35 seconds. Audio is never written to disk or stored. Diagnostics (timings, events and device details, never names or audio) are described in the privacy policy.

## What to Test (per build)

`deploy/appstore/asc.ts release <build> --notes "…"` sets these. For the next build (the hearing-aid fix):

> The start of a message is no longer cut off when Bluetooth hearing aids or headphones switch links as a message starts. Please listen for clipped first words on Bluetooth, and tell us if you hear the first half-second of a message twice.

## Open questions for Steve

- The review contact's name, phone and email.
- Whether App Review needs to see an incoming ring. The Test Bot answers but never rings; a "ring me back" option would be a follow-up.
- The DATA paragraph follows the privacy policy's "Your voice" section (overandout.app/privacy).
