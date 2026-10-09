# Rename: Over&Out → Nowza

**Decided 2026-10-09 by Steve.** The app was called "Over&Out: Watch Walkie Talkie". It becomes
**"Nowza: Walkie Talkie + Watch"** (28 of 30 characters; Steve already set it in App Store Connect). The reason: an earlier iPhone app,
"Over-N-Out Walkie Talkie" (DadPro Technologies, live since 2026-04-24, App Store id6761448468),
has a name that sounds the same and does the same thing.

- **Brand spelling:** `Nowza`. One word, capital N only, never "NowZa" or "NOWZA" in body text.
- **Domain:** `nowza.app` (Steve owns it, at Porkbun). It is on Firebase Hosting's site `walkie-talkie-relay`.
- **Contact email:** `nowza@cypressoakstudios.com`. It replaces overandout@cypressoakstudios.com.
- **Clearance done:**
  - The App Store in 12 countries and Google Play: no app named Nowza.
  - USPTO and TMview: the only NOWZA record is cancelled.
  - Nearest marks: WOWZA (Wowza Media Systems, Reg. 5961975, streaming software) and Noza VPN.
    Steve judged them a different word in a different market and **skipped an attorney opinion**.
  - Others with the name: nowza.co (registered 2026-09-23) and getnowza.com (2026-01). Neither has a site.

Follow AGENTS.md throughout. In particular, ask before deploys, TestFlight uploads and App Store
Connect changes. Simulators come first, then devices. Swift must build with no warnings. Stage files
by name. Use separate PRs for independent work, and say how you'll split it before opening them.
Suggested split: **PR A** apps + server strings + entitlements, **PR B** website, **PR C** docs and
art. Hosting setup and DNS are not code.

**Changed later on 2026-10-09: Steve retires overandout.app.** Few people know it, so every
breaking change happens at once: the apps, API, relay, Ops and website move entirely to nowza.app,
and builds made before the move stop working until testers install the new one. Section 0's
domain items below are superseded; section 1a lists the retirement.

## 0. Do NOT rename these

These identifiers are internal, and existing installs, old builds and links already sent depend on
them. Leave every one as it is, even though it says "overandout".

- **Bundle IDs:**
  - `com.cypressoakstudios.overandout`
  - `….watchkitapp`
  - `….watchkitapp.notificationservice`
  - the `.dev` variants
  - Users never see these, and they can't change after release.
- **Keychain, UserDefaults and notification names.** Changing these signs everyone out or **loses their E2EE keys**:
  - `com.cypressoakstudios.overandout.session` (`Account.swift`, `WatchNotificationService/NotificationService.swift`)
  - `com.cypressoakstudios.overandout.e2ee` (`E2EEKeyStore.swift`)
  - `com.cypressoakstudios.overandout.telemetry` and `.diagnostics` (`Telemetry.swift`)
  - `OverAndOutSignedOut` (`Account.swift`) and `OverAndOutUpgradeRequired` (`Contract.swift`)
- **Code and project names:**
  - `OverAndOutKit`, `OverAndOut.xcodeproj`, the `OverAndOut` and `OverAndOutWatch` targets and schemes
  - `OverAndOutWatchNotificationService`
  - asset names `OverAndOutMascot` and `OverAndOutBrand`
  - Renaming them churns `testflight.sh`, CI and docs for no user benefit. That's optional later work with its own PR.
- **Server and test identifiers:**
  - `test-bot.overandout` and `canary.overandout` (account IDs)
  - `demo-overandout` (Firestore emulator project)
  - the GCP project `walkie-talkie-relay`
  - Cloud Run service names
- ~~**Relay hostnames** and **`overandout.app` itself**~~: superseded. overandout.app is retired
  (section 1a); the relays, API, invites, AASA and Ops are on nowza.app, and
  `Contract.approved(_:bundled:)` trusts only nowza.app relays.
- **Firebase Hosting site names** `walkie-talkie-relay` and `overandout-ops`: sites can't be renamed,
  and users never see them.

## 1. DNS and hosting (Steve does DNS; ask before running setup)

State on 2026-10-09:

| Record | Now | Should be |
|---|---|---|
| `nowza.app` TXT | `hosting-site=walkie-talkie-relay` ✅ | same |
| `www.nowza.app` CNAME | `walkie-talkie-relay.web.app` ✅ | same |
| `nowza.app` A | `199.36.158.100` ✅ (Steve replaced Porkbun's parking ALIAS, 2026-10-09) | same |
| `*.nowza.app` | deleted ✅ | none |

- [x] **Steve, at Porkbun:** removed the parking ALIAS and the wildcard, and added the root A record (checked on Porkbun, Google and Cloudflare DNS, 2026-10-09). Porkbun shows root records with an empty Host, not `@`.
- [x] **Add the custom domains to the Hosting site (ask first).** Run with `export PATH=$HOME/google-cloud-sdk/bin:$PATH`: *(Done 2026-10-09 with Steve's OK: both hosts and ownership active, certificates propagating, no DNS changes needed.)*
  - `WEB_DOMAIN=nowza.app deploy/gcp/deploy-web.sh setup`
  - `WEB_DOMAIN=www.nowza.app REDIRECT_TO=nowza.app deploy/gcp/deploy-web.sh setup`

  `setup` prints the records it expects. Compare them with the table above, because Firebase may want an extra TXT for the certificate. On 2026-10-09 neither custom domain existed (`deploy-web.sh dns` returned 404 `CD_NOT_FOUND`).
- [x] **Wait for the certificate:** `WEB_DOMAIN=nowza.app deploy/gcp/deploy-web.sh dns`. Then check that `https://nowza.app/.well-known/apple-app-site-association` and `https://nowza.app/v2/health` load. They should, because it's the same site with the same rewrites to the API. *(nowza.app and www.nowza.app certificates active; AASA and `/v2/health` load, 2026-10-09.)*
- [x] **Fix the script comments.** `deploy-web.sh` and `firebase-hosting.ts` say "GoDaddy's DNS records" and default `WEB_DOMAIN` to overandout.app. Make the default `nowza.app` and say that nowza.app's DNS is at Porkbun. *(PR B.)*
- ~~**Later (optional):** redirect overandout.app's HTML pages to nowza.app.~~ Superseded: the domain is retired (section 1a).

## 1a. Retire overandout.app (Steve, later on 2026-10-09)

- [x] **Apps (PR A):** `OAO_API_HOST = nowza.app`, `OAO_SERVER_HOST = relay-1.nowza.app`, only `applinks:nowza.app`, and `ServiceConfigStore.approved` trusts only nowza.app. Server and script defaults name nowza.app. *(#63.)*
- [x] **Relay certificate:** `relay-1`'s `relay-hostnames` stateful metadata is `relay-1.nowza.app walkie.cypressoakstudios.com`, then a relay deploy (Caddy gets the certificate). Porkbun has `relay-1.nowza.app` A 35.209.96.216. *(relay-1.nowza.app answers `/healthz` over valid TLS.)*
- [x] **`config.sh`:** `RELAY_PUBLIC_HOST=relay-1.nowza.app`, `RELAY_NODES=https://relay-1.nowza.app`, `INVITE_BASE_URL=https://nowza.app/i/`, `OPS_DOMAIN=ops.nowza.app`, `SUPPORT_EMAIL=nowza@cypressoakstudios.com`. *(Only `SUPPORT_EMAIL` needed setting; the scripts' defaults are nowza.app.)*
- [x] **Deploys:** the relay, the API, Ops (`setup-ops.sh`), the stats jobs (`setup-stats.sh`), the website, and `setup-telemetry.sh`. *(Steve ran them, 2026-10-09: relay, API, Ops and both stats jobs on `57746e5`; website from #64. The API's `/v2/config` names relay-1.nowza.app and invites are on nowza.app. The 23:15 Canary: relay 1/1, 1280 ms.)*
- [x] **Ops address:** `ops.nowza.app` on the Hosting site `overandout-ops` (`setup-ops-redirect.sh`). Porkbun has `ops.nowza.app` CNAME `overandout-ops.web.app`. *(Added; its certificate was still validating at 23:15.)*
- [x] **Monitoring:** uptime check and "Relay down" alert for `relay-1.nowza.app` (`setup-uptime.sh`), then delete the overandout.app ones. *(Done. The old uptime check could only be deleted after its alert policy, which uses it.)*
- [x] **Remove from Firebase Hosting:** `overandout.app`, `www.overandout.app` and `ops.overandout.app`. *(Done; overandout.app/v2/health is 404. The CDN serves cached pages for up to an hour.)*
- [x] **Steve, in the console (no API without a Google Cloud organization):** Google Auth Platform → Branding: app name Nowza, home page `https://nowza.app`, privacy policy `https://nowza.app/privacy`; Authorized domains: add `nowza.app` (it may send you to Search Console for a Porkbun TXT record), remove `overandout.app`. Optional: rename the client "Over&Out Ops (IAP)". *(Done by Steve. A failed earlier branding verification blocked edits until nowza.app was verified in Google Search Console (Domain property, TXT record at Porkbun) and re-verification was requested with "I have fixed the issues".)*
- [ ] **Steve, GoDaddy:** let overandout.app lapse (turn auto-renew off) once nothing above needs it.
- [ ] **Local tools:** the `bot.ts` and test-account token files name `https://overandout.app` as their API; point them at `https://nowza.app`.

## 2. Apps (PR A)

### Display name and user-visible text
- [x] **`INFOPLIST_KEY_CFBundleDisplayName = "Over&Out"`:** set it to `"Nowza"` in all 5 places in `app/OverAndOut.xcodeproj/project.pbxproj` (lines ~394, 424, 454, 485, 515). *(PR A: 6 places, plus the microphone text.)*
- [x] **Every user-visible string with "Over&Out":** *(PR A. About's line under the logo is now "Walkie Talkie + Watch".)*
  - **Kit:** `Account.swift` (188, 199, 202, 207), `Contract.swift` (23, 295)
  - **Watch:** `ContentView.swift`, `FriendsListView.swift`, `SettingsView.swift`, `WatchAccount.swift`
  - **iOS:**
    - `AboutView.swift`: name, "Rate Over&Out", "Available once…", the email on line 8 → `nowza@cypressoakstudios.com`, and the visible link text `"overandout.app"` → `"nowza.app"`
    - `AppModel.swift` (405, 598)
    - `DeleteAccountView.swift`: including the "**Sign in to Over&Out**" sheet wording. Apple's sheet shows the new name once the display name changes
    - `FriendDetailView.swift`
    - `FriendsView.swift`, including the **invite share text** on lines 227 and 231: "Let's talk on Nowza, a walkie-talkie for Apple Watch: …" and "… invited you to Nowza"
    - `InviteAcceptView.swift`
    - `OnboardingView.swift` (several, including the Focus steps "choose **Nowza**")
    - `PushToTalkChannel.swift` (7, 194, 296, 321, 322): the PushToTalk channel name shown on the Lock Screen
    - `ReportProblemView.swift`
    - `RootView.swift` (57, 59)
  - **Tests asserting these strings:** `RelayConnectionTests.swift` (190, 198) and any other `"Update Over&Out"` checks.
  - **Check:** `git grep -n -E 'Over&Out|Over and Out' -- app ':!*.png'` should leave only comments, if anything.
- [x] **Server-sent text the apps show:** `server/src/contract.ts:256` `"Update Over&Out to keep talking."` → `"Update Nowza to keep talking."`, plus the matching tests and `contracts/examples`. Push alerts are "<friend name>" / "Tap to listen" (`server/src/apns.ts`), so they need no change. *(PR A.)*

### Invite links on nowza.app
- [x] **Entitlements:** `app/Config/iOS.entitlements` and `iOS-NoPush.entitlements` have `applinks:$(OAO_LINK_DOMAIN)`. Keep the old domain and add the new one: *(PR A, after the retirement: only `applinks:$(OAO_LINK_DOMAIN)`, which is nowza.app. www.nowza.app is left out: Firebase redirects every path there, AASA included, and Apple doesn't follow AASA redirects.)*
  - `applinks:nowza.app`
  - `applinks:www.nowza.app`
  - `applinks:overandout.app`, so links already sent keep opening the app

  The Associated Domains capability is already on the App ID, so Xcode's automatic signing regenerates the profiles.
- [x] **`app/Config/Base.xcconfig`:** `OAO_LINK_DOMAIN = nowza.app`. Keep `OAO_API_HOST = overandout.app` and `OAO_SERVER_HOST = relay-1.overandout.app` (section 0). *(PR A.)*
- [x] **`AppModel.swift:546`** only accepts `linkDomain` and `www.linkDomain`. Also accept `overandout.app` (and `www.`), so old links work in new builds. Change the `?? "overandout.app"` fallback on line 92 and the `?? URL(string: "https://overandout.app")` on line 94 to whatever matches the new defaults. Keep the API on overandout.app unless you move it deliberately. *(PR A.)*
- [x] ~~**Order matters for invites:**~~ *(Moot: overandout.app is retired and old builds stop working anyway.)* switch the API's `INVITE_BASE_URL` to `https://nowza.app/i/` (section 3) only **after** the minimum build includes `applinks:nowza.app`. Until then, old builds open nowza.app links in Safari (the invite fallback page) instead of the app.

### Art inside the apps
- [x] **`OverAndOutBrand`** (the stacked mascot plus **"Over&Out" wordmark** on indigo) is used by About. It needs a new **Nowza** wordmark from Steve, or About can show the mascot plus native text instead. The same applies to `art/masters/brand-stacked-indigo.png`, `art/masters/lockup-horizontal-dark.png`, `art/documentation/over-and-out-horizontal-*.png` and `art/merch/lockup-horizontal-dark-300dpi.png`. Steve decides how to produce the new wordmark (it's raster art with no font file; see `art/README.md`). *(PR #62.)*
- [x] **App icons** (`art/icons/*/OverAndOut-1024.png`): check them for any lettering. Expected: mascot only, no change. *(No lettering, per PR #62.)*

### Checks
- [x] Kit `swift test`. *(81 passed.)*
- [x] iPhone and watch Debug simulator builds, plus a Release device build, with **no warnings**. *(PR A, no Swift warnings.)*
- [x] In the simulators (local relay + API): the name on the home screen and in About, the invite share text, and a nowza.app invite link and an overandout.app invite link both open the app. *(Names, About and the nowza.app invite link checked. Universal links can't open in the simulator, because the `.dev` bundle ID isn't in AASA; check them on TestFlight.)*
- [ ] **TestFlight build (ask first).** On devices:
  - the home-screen name, the Lock Screen PushToTalk name, and Sign in with Apple's sheet
  - **re-measure push → first audio** on the locked iPhone, because `PushToTalkChannel.swift` changed (AGENTS.md); check Ring Me On first

## 3. Server and config (part of PR A, plus config Steve owns)

- [x] **`deploy/gcp/config.sh`** (gitignored): `SUPPORT_EMAIL="nowza@cypressoakstudios.com"`. The privacy, support and terms pages pick it up through `firebase-hosting.ts`.
- [x] **`INVITE_BASE_URL`** for the API *(PR A: `deploy-api.sh` reads it from `config.sh`, default `https://nowza.app/i/`; deployed with the retirement, section 1a.)* (`server/src/api-main.ts` defaults to `https://overandout.app/i/`). Change the default and the deployed value to `https://nowza.app/i/`, in the order given in section 2, then deploy the API (ask first).
- [x] **Comments and defaults** that only describe the domain (`api-main.ts`, `api.ts`, `ops-main.ts`, `rolling-main.ts`, `stats.ts`, `telemetry.ts`): update the product name in comments. Leave relay URLs alone. *(PR A.)*
- [x] **Optional, later, ask first:** *(PR A, Steve's OK: "Nowza Ops", "Nowza Beta" and "Nowza: …" alerts, renamed in place by `setup-telemetry.sh`. The OAuth consent screen is Steve's, in the console.)*
  - the Ops dashboard title "Over&Out Ops" (`ops-main.ts`)
  - the Cloud Monitoring dashboard "Over&Out Beta" (`setup-telemetry.sh`)
  - the Ops OAuth consent screen name

## 4. Website (PR B)

- [x] **`web/public/index.html`, `invite.html`, `privacy.html`, `support.html`, `terms.html`:** *(PR B.)*
  - "Over&Out" (and `Over&amp;Out`) → "Nowza"
  - overandout.app links → nowza.app
  - In privacy and terms, update the effective or updated date. Keep "Cypress Oak Studios, LLC" as the operator.
- [x] **`web/public/.well-known/apple-app-site-association`:** no change. It lists app IDs, and the same file serves both domains.
- [x] **Deploy the website (ask first):** `deploy/gcp/deploy-web.sh`. Then check both domains in a browser. *(nowza.app only; overandout.app is retired.)*

## 5. App Store Connect, TestFlight and store assets (ask Steve before each change)

- [x] **App name:** "Nowza: Walkie Talkie + Watch". Steve set it on 2026-10-09.
- [ ] **URLs:** privacy policy, support and marketing → `https://nowza.app/privacy`, `/support`, `/`.
- [ ] **TestFlight:**
  - the Feedback Email → `nowza@cypressoakstudios.com`
  - the beta app description
  - the "What to Test" notes of the next build should mention the rename
- [x] **`deploy/appstore/beta-review-notes.md`:** name and contact email. *(PR C.)*
- [x] **`deploy/appstore/product-page-copy.md`:** *(PR C.)*
  - "Over&Out" → "Nowza" throughout
  - the header note's assumed app name
  - the app name, the "Renamed" note and the keywords (with `phone`) were already updated on 2026-10-09; recheck duplicates only if the name or subtitle changes
  - remove the "being renamed" note
- [x] **`deploy/appstore/creative-assets/compose.swift`** and its outputs: the text is "Walkie-talkie for iPhone + Apple Watch", with no name in the strings. Check that the UI captures it composes don't show "Over&Out" (for example About). Regenerate and get Steve's approval if they do. *(OCR of its outputs finds no old name.)*
- [ ] **`deploy/appstore/screenshots/`:** retake any screenshot that shows the old name. *(OCR, 2026-10-09: `iphone-2-locked` (Lock Screen "Over&Out", from Steve's iPhone), `iphone-5-friends` and `iphone-7-ring-choice` (masthead and text). Retake after PR A merges.)*
- [x] **`deploy/appstore/asc.ts` and `testflight.sh`:** check for hard-coded names (scheme and archive names stay, per section 0). *(Only section 0 identifiers.)*

## 6. Docs and repo (PR C)

- [x] **Product name in prose:** `README.md`, `AGENTS.md` (first line, plus the overandout.app mentions that should now say nowza.app), `HANDOFF.md`, `app/README.md`, `contracts/README.md`, `art/README.md` ("Brand spelling is **Over&Out**" → **Nowza**), `art/GENERATION.md`, `E2EE_SPEC.md`, `OPS_DASHBOARD_SPEC.md`, `ANDROID_WEAR_OS_PLAN.md`, `SWIFT6_MIGRATION_PLAN.md`, `.claude/agents/` (run-analyst), and workflow display names in `.github/workflows/` (not job IDs CI depends on). *(PR C.)*
- [x] **Leave historical log entries in HANDOFF.md as written.** Add a new top entry about the rename. *(PR C.)*
- [ ] **Claude Docs (optional):** the titles of the feasibility doc, backlog, telemetry spec and App Store pre-submission checklist. The feasibility doc's Design decisions table already has the rename decision (2026-10-09).

## 7. Email

- [ ] **Steve:** confirm `nowza@cypressoakstudios.com` receives mail, for example by sending it a test message. Keep `overandout@cypressoakstudios.com` forwarding, since testers and Apple have it.
- [ ] **Everywhere the address appears:**
  - `config.sh` `SUPPORT_EMAIL` (section 3)
  - `AboutView.swift:8` (section 2)
  - `beta-review-notes.md` and the TestFlight Feedback Email (section 5)
  - The Ops OAuth consent screen stays support@ (it isn't for customers).

## 8. Done when

- [ ] `git grep -n -I -E 'Over&Out|Over&amp;Out|Over and Out'` shows only historical entries (HANDOFF log, decision records) and section 0 identifiers.
- [ ] `https://nowza.app`, `/privacy`, `/support`, `/terms` and `/i/<code>` load with a valid certificate. `www.nowza.app` redirects to `nowza.app`. `relay-1.nowza.app` and `ops.nowza.app` have valid certificates, and overandout.app is gone from Google Cloud.
- [ ] On a TestFlight build:
  - the home screen, Lock Screen PushToTalk, About and invites say Nowza
  - nowza.app invite links open the app
  - push → first audio is re-measured and recorded in the feasibility doc
- [ ] App Store Connect shows "Nowza: Walkie Talkie + Watch" with nowza.app URLs.
- [ ] HANDOFF.md "Start here" describes the rename and anything still pending.
