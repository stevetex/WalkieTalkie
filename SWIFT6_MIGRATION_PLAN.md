# Swift 6 language-mode migration plan

Date: 2026-09-29

Status: Planning only; implementation has not started.

## Objective and recommendation

Adopt Swift 6 language mode in the Over&Out shared package, iPhone app, Watch app,
and Watch notification service extension. Use the compiler's concurrency checks
to make ownership of mutable state and transfers between execution contexts
explicit, while preserving audio timing and existing behavior.

Proceed incrementally after the current audio fixes have a verified device
baseline. The expected benefit is stronger protection against concurrency
regressions. Faster delivery, better sound quality, and lower battery use are not
assumed outcomes.

This is a language-mode migration. The selected Xcode 27.0 toolchain already uses
Apple Swift 6.4, the latest released compiler verified during this assessment.
No toolchain installation is needed for the proposed work.

## Verified starting point

| Area | Current state |
| --- | --- |
| Selected tools | Xcode 27.0, build 27A266a; Apple Swift 6.4 |
| App project | `app/OverAndOut.xcodeproj/project.pbxproj`: all three targets specify `SWIFT_VERSION = 5.0` in Debug and Release |
| Shared package | `app/Packages/OverAndOutKit/Package.swift`: tools version 6.2; library and test targets explicitly use `.swiftLanguageMode(.v5)` |
| Deployment minimums | iOS 16 and watchOS 9; package macOS 26 support exists for host-side tests |
| Swift dependencies | No external package dependencies declared in OverAndOutKit |
| Existing isolation | AccountClient and PhotoCache are actors; several iPhone controllers use `@MainActor`; some lock/queue-backed types use `@unchecked Sendable` |
| Watch controllers | ConversationController and WatchAccount use main-queue conventions without class-level `@MainActor` annotations |

A diagnostic macOS build of OverAndOutKit with
`-strict-concurrency=complete` succeeded in Swift 5 mode and reported 21 distinct
concurrency warnings: 20 in AudioPipeline and one in RelayConnection. The audio
warnings concern non-Sendable captures and transfers to the main queue. The relay
warning concerns mutable state in a Sendable-conforming delegate class.

This was a package build, not a test run or an iOS/watchOS build. The count is a
starting inventory, not a count of confirmed bugs or the total migration scope.
Apple-platform conditional code and the test target need separate coverage.

At assessment time, AudioPipeline.swift, Watch/ConversationController.swift, and
iOS/TalkController.swift already contained uncommitted changes. Preserve them and
establish their intended baseline before implementation; do not reset or absorb
them silently into migration work.

## Scope and constraints

- Migrate OverAndOutKit, its tests, OverAndOut, OverAndOutWatch, and
  OverAndOutWatchNotificationService.
- Keep iOS 16/watchOS 9 deployment support and the existing package macOS minimum.
  Check API availability before adopting newer synchronization or library APIs.
- Keep relay protocol, account/session semantics, push behavior, prefetch file
  format, codec, and user-visible features unchanged.
- Leave the retired `watch/WalkieSpike` prototype, artwork scripts, Node server,
  infrastructure, and website outside this migration.
- Retain the package tools version of 6.2 unless an actual manifest requirement
  justifies raising it. It already supports explicit Swift 6 language mode.
- Treat default MainActor isolation and Approachable Concurrency feature switches
  as separate decisions. Do not enable them globally as a shortcut, especially
  in the shared audio/transport package.
- Do not replace the audio architecture wholesale or add unchecked annotations
  simply to obtain a clean build. Any remaining escape hatch needs a documented,
  reviewable synchronization invariant.

## Phase 1: establish the baseline and complete the inventory

1. Re-read the current handoff and inspect the working tree. Identify the exact
   source baseline, including the current audio fixes, and record the toolchain
   and build configuration used for measurements.
2. Run the existing package tests and normal Debug/Release app builds. Record
   existing failures and warnings separately from migration findings.
3. Build and test OverAndOutKit with complete concurrency checking in Swift 5
   mode. Build all app targets in Debug and Release with
   `SWIFT_STRICT_CONCURRENCY=complete`, initially using command-line overrides.
   Verify that the package receives its own strict-checking flags; do not assume
   the Xcode app setting propagates into its SwiftPM targets.
4. Inventory unique diagnostics by target, file, isolation boundary, and proposed
   fix. Include test fixtures, Objective-C delegate callbacks, notification
   observers, detached tasks, and existing unchecked conformances.
5. Capture current device behavior and timing for the matrix below before changing
   isolation. Historical handoff timings are context, not a substitute for this
   baseline.

**Exit criteria:** baseline results and diagnostic inventory exist for the package,
tests, and all three app targets; the current audio fixes have been validated on
devices. Any environment limits are recorded explicitly.

## Phase 2: make the shared package concurrency-safe

Resolve warnings in Swift 5 mode first, in small reviewable changes.

| Area | Planned work | Required invariant |
| --- | --- | --- |
| Value types | Review relay messages, frames, timelines, and callback payloads; add checked Sendable conformances where all stored state permits it | Values crossing boundaries carry safe, independent state |
| RelayConnection | Express ownership of connection state and bridge URLSession delegate callbacks into that owner; audit callback signatures and close/reconnect ordering | Parser, outbox, connection state, and callbacks remain serialized; POST ordering and failure semantics stay intact |
| AudioPipeline | Map every field and method to the main thread, audio queue, or capture-tap thread; separate ownership where necessary and make callback transfers explicit | Engine lifecycle and queue work cannot race; captured/played frames remain ordered |
| Account/session code | Audit actor boundaries and lock-protected session stores, including existing unchecked conformances | Refresh/sign-out races cannot restore an obsolete session |
| Telemetry and diagnostics | Audit mutable callbacks, lock coverage, serial file writes, and values crossing tasks | Logging and uploads remain safe and do not block audio callbacks |
| Tests | Audit shared URLProtocol fixtures and mutable static state; preserve deterministic cleanup and serialization where required | Concurrent tests cannot consume each other's replies or requests |

AudioPipeline needs the most deliberate design work. Before implementation,
write down the ownership of engine replacement, encoder/decoder state, capture
conversion, queued buffers, drain watchdogs, and public callback properties.
Choose the smallest design that makes that ownership enforceable.

Keep processing off the main actor where required. Do not introduce blocking
waits, queue synchronization cycles, or unnecessary Task hops in the capture and
playback paths. A serial DispatchQueue remains a valid design, but its safety
must be justified at every boundary the compiler cannot verify.

Add focused regression tests for behavior affected by the changes, particularly
callback ordering, cancellation, reconnect, and stale completion handling. Use
existing tests where they already cover the invariant; avoid tests that merely
check for annotations.

**Exit criteria:** the package and its tests pass with complete concurrency
checking and no concurrency diagnostics, including platform-specific builds.
Any retained unchecked boundary has an explicit justification and review.

## Phase 3: migrate the app boundaries

1. **iPhone:** review AppModel, TalkController, PushToTalkChannel, PhoneWatchLink,
   AppleSignIn, and diagnostics. Preserve existing main-actor ownership. Bridge
   nonisolated framework callbacks using safe payloads and explicit execution
   boundaries. Keep required synchronous delegate responses synchronous.
2. **Watch:** make UI and conversation state ownership explicit in
   ConversationController and WatchAccount. Audit notification handling,
   WatchConnectivity, token callbacks, timers, and prefetch playback. Do not
   assume that execution on the main queue alone resolves every actor-isolation
   requirement in protocol conformances.
3. **Notification extension:** serialize request state across network completion
   and `serviceExtensionTimeWillExpire`. Ensure the content handler is delivered
   once even when completion and expiry overlap. Preserve account scoping,
   expiration metadata, atomic writes, and the extension's small dependency set.
4. Audit every `@unchecked Sendable`, `nonisolated(unsafe)`, and any proposed
   `@preconcurrency` use. Record why it is needed and which invariant makes it
   safe; remove it when a checked design is practical.

**Exit criteria:** all three app targets build in Debug and Release with complete
checking and no concurrency diagnostics. Targeted behavior tests pass.

## Phase 4: enable Swift 6 language mode

1. Change the OverAndOutKit library and test targets to
   `.swiftLanguageMode(.v6)`; rerun package tests and consumer builds.
2. Change `SWIFT_VERSION` to `6.0` for OverAndOut, OverAndOutWatch, and
   OverAndOutWatchNotificationService in both Debug and Release. Enable one
   target at a time, rebuilding its dependencies and consumers at each step.
3. Resolve additional Swift 6 diagnostics without broadly suppressing checks.
   Verify effective compiler arguments, not only the text of project settings.
4. Rebuild from fresh build output and repeat the targeted tests. Explicitly
   cover the extension and platform-specific branches that the macOS package
   build cannot exercise.
5. Record final settings and routine validation commands in `app/README.md` as
   part of the future implementation.

**Exit criteria:** library, tests, and all three app targets compile in Swift 6
mode; package tests pass; Debug and Release builds are clean of concurrency
diagnostics; deployment minimums remain unchanged.

## Validation matrix

| Layer | Required checks |
| --- | --- |
| Package | Existing account, relay-record, codec, timeline, ring, mascot, and telemetry tests; new behavioral regression tests for changed boundaries |
| Build | iPhone and Watch simulator builds, notification extension, and Release device compilation; verify effective Swift 6 mode for every target |
| Local integration | iPhone-to-Watch, Watch-to-iPhone, and iPhone-to-iPhone messaging; first burst and replies; accept/decline, timeout, relay loss, and reconnect |
| Account/connectivity | Sign-in, refresh, sign-out during an in-flight request, phone-to-watch session transfer, and account-scoped prefetch |
| iPhone hardware | Locked/background PushToTalk receive, Lock Screen reply, Leave/rejoin, audio interruption and route changes, and playback-only receive without unwanted microphone activation |
| Watch hardware | Cold notification tap, foreground answer, answer mid-message, prefetch success/failure, replay deduplication, first words preserved, and complete playback drain |
| Extension | Completion versus expiry/cancellation, missing or expired session, network failure, and exactly-once handler delivery |
| Timing | Repeated matched before/after runs for watch tap-to-first-audio, iPhone push-to-first-audio, and reply/capture latency; separate APNs delivery from app processing |
| Compatibility | Physical iOS 16/watchOS 9 coverage where available; unavailable older-device coverage must remain an explicit release limitation |

Measure device timing without the Xcode debugger attached. Keep device, network,
audio route, push environment, and cold/warm state matched. Use at least ten
successful runs per primary timing scenario and report median, range, and
failures. Investigate any repeatable slowdown outside baseline variation, missing
first words, duplicate playback, hangs, or new crashes before release. This small
sample is a regression check, not proof of battery or tail-latency improvement.

Use Thread Sanitizer on supported simulator/test configurations as an additional
check for changed mutable-state boundaries. Sanitizer and debugger runs do not
count as latency measurements, and a clean sanitizer run does not establish
correctness of unchecked annotations.

## Suggested implementation checkpoints

1. Diagnostic inventory, baseline, and ownership design.
2. Shared-package concurrency fixes and behavioral tests.
3. iPhone and Watch boundary fixes; extension completion/expiry handling.
4. Swift 6 settings, final validation, and updated build documentation.

Keep audio ownership changes separately reviewable even if they require small
caller changes. Re-run affected tests at each checkpoint; do the full device
matrix after the final state. Migration completion requires both compilation and
behavioral validation, not merely removal of warnings.

## Release and rollback

Prepare a reviewable local build and evidence before any distribution step.
Committing, pushing, opening a PR, or uploading to TestFlight requires separate
authorization; this written plan authorizes none of them. Existing handoff rules
for outward-facing actions continue to apply.

Preserve the validated pre-migration source and build identity. If behavior
regresses, revert the relevant migration checkpoint or restore that baseline.
Changing the language-mode setting back to Swift 5 alone does not undo ownership
or scheduling changes. No server deployment or data migration is planned.

## Completion checklist

- [ ] Current audio fixes validated and baseline recorded.
- [ ] Diagnostic inventory completed for every target and tests.
- [ ] Ownership and callback boundaries reviewed, including unchecked code.
- [ ] Shared package, tests, iPhone, Watch, and extension use Swift 6 mode.
- [ ] Debug/Release builds and package tests pass without concurrency diagnostics.
- [ ] Device/integration matrix completed; timing regressions resolved.
- [ ] iOS 16/watchOS 9 support preserved; any untested coverage recorded.
- [ ] Build documentation and rollback reference updated.
- [ ] Release evidence ready for review; distribution separately authorized.

## References

- [Swift 6.4 release](https://www.swift.org/blog/swift-6.4-released/)
- [Swift 6 concurrency safety and language mode](https://www.swift.org/blog/announcing-swift-6/)
- [Swift concurrency migration strategy](https://www.swift.org/migration/documentation/swift-6-concurrency-migration-guide/migrationstrategy/)
- [Apple Xcode compiler and deployment support](https://developer.apple.com/xcode/system-requirements)
- Repository context: [app README](app/README.md), [handoff](HANDOFF.md), and
  [package manifest](app/Packages/OverAndOutKit/Package.swift).

Toolchain facts and diagnostics above were checked on 2026-09-29. Reconfirm them
against the intended implementation baseline before starting.
