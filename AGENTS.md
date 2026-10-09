# **AGENTS.md**

Nowza: Walkie Talkie + Watch (nowza.app) is a Walkie-Talkie app for Apple Watch and iPhone (and, later, Android and Android Wear), functionally modeled after the now-retired (with WatchOS 27)  Apple Watch Walkie-Talkie app. The watch and iPhone apps, accounts, the relay and API on Google Cloud, and the branded website are built and live. It was called Over&Out (overandout.app, now retired) until 2026-10-09: bundle IDs, keychain and UserDefaults keys and `OverAndOut*` code names keep that name (RENAME_CHECKLIST.md, section 0). The app is currently targeting WatchOS 10.2 and higher and iOS 17 and higher, as these are the minimum simulator image versions supported by the latest XCode.

Start by reading HANDOFF.md at the repo root. This file has been a running log of what's happened from one to the next prompt session. The "Start here" section usually contains what's just happened and what's ready to be done next. Keep this file up-to-date from session to session.

Constraints:
- Ask before:
  - creating any billed Google Cloud resources;
  - deploying to the live relay, the API or the website;
  - TestFlight uploads (say before each one);
  - changing App Store Connect or the developer portal beyond what Xcode and testflight.sh do;
  - deleting anything (VMs, data, accounts, files you didn't create).
- When a deploy or other outward action is blocked by the permission checker, give me the exact command to run instead of working around it.
- I add DNS records at GoDaddy myself, so give me the exact records when you need them.
- Host only on Google Cloud (no Cloudflare), with no manual VM or OS patching.
- Commit or push only when I ask, and stage files by name. Anything non-trivial is merged into main via Pull Request, but small, trivial changes can go direct to main with explicit permission.
- Never print the relay token, APNs keys, signing keys, the App Store Connect key, session tokens or a built app's Info.plist.
- Check changes in the simulators first (a local relay with the API, as in HANDOFF's Simulator section; PushToTalk doesn't run there), then on my devices without the debugger (the TestFlight build).
- If a change touches the watch's ring or answer path, or the iPhone's PushToTalk path, re-measure tap → first audio or push → first audio.
- Record design decisions and measured results in the feasibility doc, and small non-blocking follow-ups in the backlog doc.
- Swift code must conform to language model 6. Do not check-in swift code that throws compiler warnings or errors - address warnings, and do not supress them without explicit permission.
- Keep HANDOFF.md current at the end of the session.
