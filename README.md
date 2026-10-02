# Over&Out: Watch Walkie Talkie

A walkie-talkie for Apple Watch and iPhone (overandout.app), modeled on the Walkie-Talkie app
Apple removed in watchOS 27. The current state and next steps are in [HANDOFF.md](HANDOFF.md).

```
app/         The iPhone app, the watch app, the watch's notification extension, and the
             shared Swift package OverAndOutKit (see app/README.md)
server/      The relay and the account API (Node 24+, TypeScript, no dependencies)
contracts/   The service contract the apps and the server share: spec, JSON Schemas,
             examples and binary fixtures (contracts/README.md)
deploy/      Google Cloud (deploy/gcp/README.md) and App Store Connect (deploy/appstore)
web/         overandout.app's pages
```

The project began as a ring-to-start spike: a watch-only app (`watch/WalkieSpike`) against the
first relay, which proved a watch can be rung once per conversation and hear the sender's first
words after answering. The spike app was removed on 2026-10-01, when the service moved to the v2
contract it doesn't speak; it's in the git history before then, and its measurements are in the
feasibility doc (linked from HANDOFF.md).
