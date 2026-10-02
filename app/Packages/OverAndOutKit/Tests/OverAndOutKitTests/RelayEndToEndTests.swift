import Foundation
import Testing
@testable import OverAndOutKit

/// Swift → relay → Swift: the path the apps use, less the microphone and speaker, over the v2
/// contract. Two dev accounts sign in through the API (an iPhone, and a watch that isn't
/// connected), become friends by an invite, and the watch registers for alert rings. Speech
/// encoded with the kit's encoder goes through a real relay to the watch; the watch finds the
/// ring by the pending-ring lookup, answers it and joins it by its ID (in the stream request, as
/// the app does), hears the replay, then a second burst live. Every frame must arrive as sent,
/// and the decoded speech must keep its level. Runs only against a relay named by
/// OAO_E2E_RELAY (CI starts one: kit.yml):
///
///   SPIKE_TOKEN=ci SERVE_API=1 DEV_APPLE_SIGNIN=1 PORT=8095 DATA_DIR=<dir> node server/src/main.ts
///   OAO_E2E_RELAY=http://127.0.0.1:8095 swift test
@MainActor
@Suite(.serialized, .enabled(if: e2eRelay != nil, "set OAO_E2E_RELAY to a local relay serving the API"))
struct RelayEndToEndTests {
    @Test func speechCrossesTheRelayIntactAndAtItsLevel() async throws {
        let base = try #require(e2eRelay)
        let id = UUID().uuidString.prefix(8).lowercased()
        let phone = ClientIdentity(kind: .ios, version: "e2e", build: "1", encodes: ["opus16k"])
        let watch = ClientIdentity(kind: .watchos, version: "e2e", build: "1", encodes: ["opus16k"])
        let aliceAccount = AccountClient(baseURL: base, store: MemorySessionStore(), identity: phone)
        let bobAccount = AccountClient(baseURL: base, store: MemorySessionStore(), identity: watch)
        let alice = try await aliceAccount.signInWithApple(identityToken: "dev:kit-a-\(id)", nonce: "n", name: "Alice", deviceId: "kit-a-\(id)").session
        let bob = try await bobAccount.signInWithApple(identityToken: "dev:kit-b-\(id)", nonce: "n", name: "Bob", deviceId: "kit-b-\(id)").session
        let invite = try await aliceAccount.createInvite()
        _ = try await bobAccount.acceptInvite(code: invite.code)
        // An alert delivery the local relay only logs: the first Talk rings and the relay holds the audio.
        try await bobAccount.registerDevice(DeviceRegistration(delivery: .alert(token: "e2e-\(id)", environment: "sandbox"), notifications: .authorized))

        let speech = try Signal.speech()
        let encoder = VoiceEncoder()
        try #require(encoder.codec == .opus16k, "no Opus encoder on this machine")
        let replayed = encode(speech, with: encoder)
        let live = encode(speech, with: encoder)

        let sender = RelayConnection(identity: phone)
        var senderHeard: [RelayMessage] = []
        sender.onMessage = { senderHeard.append($0) }
        sender.connect(baseURL: base, token: alice.token)
        defer { sender.close() }
        let first = UUID().uuidString
        talk(sender, to: bob.userId, burstId: first, frames: replayed)
        try await pollUntil(seconds: 10) { senderHeard.contains { $0.type == "floor-granted" && $0.burstId == first } }
        let granted = try #require(senderHeard.first { $0.type == "floor-granted" && $0.burstId == first })
        #expect(granted.pushed == true, "the first Talk didn't ring")
        let conversationId = try #require(granted.conversationId)
        // The POSTs carrying the burst finish well within this; the watch answers later anyway.
        try await Task.sleep(nanoseconds: 500_000_000)

        // The watch finds the ring and answers it by its ID.
        let rings = RelayAPI(baseURL: base, token: bob.token, identity: watch)
        let ring = try #require(try await rings.pendingRings().first { $0.conversationId == conversationId })
        #expect(ring.ringId.hasPrefix("r_"))
        try await rings.answer(ring)
        let receiver = RelayConnection(identity: watch)
        var heard: [String: [Data]] = [:]
        var current: String?
        var messages: [RelayMessage] = []
        var firstFrameAt: [String: Double] = [:]
        receiver.onMessage = { message in
            messages.append(message)
            if message.type == "burst-start" { current = message.burstId }
            if message.type == "burst-end" { current = nil }
        }
        receiver.onFrame = { frame in
            guard let burst = current else { return }
            if firstFrameAt[burst] == nil { firstFrameAt[burst] = Clock.nowMs() }
            heard[burst, default: []].append(frame)
        }
        let answerAt = Clock.nowMs()
        receiver.connect(baseURL: base, token: bob.token, join: conversationId, ring: ring.ringId)
        defer { receiver.close() }
        try await pollUntil(seconds: 10) { messages.contains { $0.type == "burst-end" && $0.burstId == first } }
        let replayDoneAt = Clock.nowMs()

        // Now a burst while the watch is listening: forwarded live, not replayed.
        let second = UUID().uuidString
        let pressedAt = Clock.nowMs()
        talk(sender, to: bob.userId, burstId: second, frames: live)
        try await pollUntil(seconds: 10) { messages.contains { $0.type == "burst-end" && $0.burstId == second } }

        let start = { (burst: String) in messages.first { $0.type == "burst-start" && $0.burstId == burst } }
        var problems = 0
        for (burst, sent, replay) in [(first, replayed, true), (second, live, false)] {
            let got = heard[burst] ?? []
            if got != sent { problems += 1 }
            if start(burst)?.replay != replay { problems += 1 }
            #expect(got.count == sent.count, "burst \(replay ? "replayed" : "live"): \(got.count) of \(sent.count) frames")
            #expect(got == sent, "burst \(replay ? "replayed" : "live") arrived changed")
            #expect(start(burst)?.replay == replay)
        }
        KitMetrics.record("kit.e2e.integrity_failures", Double(problems), unit: "failures", kind: "integrity")

        let decoded = Signal.decode(heard[first] ?? [])
        let change = Signal.levelChange(speech, decoded)
        let snr = Signal.snr(speech, decoded)
        let liveChange = Signal.levelChange(speech, Signal.decode(heard[second] ?? []))
        KitMetrics.record("kit.e2e.level_change_db", change, unit: "dB", kind: "level")
        KitMetrics.record("kit.e2e.live_level_change_db", liveChange, unit: "dB", kind: "level")
        KitMetrics.record("kit.e2e.speech_snr_db", snr, unit: "dB", kind: "quality")
        KitMetrics.record("kit.e2e.answer_to_first_frame_ms", (firstFrameAt[first] ?? .nan) - answerAt, unit: "ms", kind: "info")
        KitMetrics.record("kit.e2e.answer_to_replay_done_ms", replayDoneAt - answerAt, unit: "ms", kind: "info")
        KitMetrics.record("kit.e2e.live_press_to_first_frame_ms", (firstFrameAt[second] ?? .nan) - pressedAt, unit: "ms", kind: "info")
        #expect(AudioLevel(decoded).rmsDbfs > -60, "the replayed speech decoded to silence")
        #expect(abs(change) < 6, "level changed by \(change) dB")
        #expect(abs(liveChange) < 6, "live level changed by \(liveChange) dB")
    }

    private func encode(_ samples: [Float], with encoder: VoiceEncoder) -> [Data] {
        encoder.reset()
        return Signal.frames(samples).enumerated().compactMap { index, frame in
            encoder.encode(frame).map { VoiceFrame.encode(codec: encoder.codec, seq: UInt32(index), payload: $0) }
        }
    }

    private func talk(_ connection: RelayConnection, to: String, burstId: String, frames: [Data]) {
        connection.send(["type": "talk-start", "to": to, "burstId": burstId, "codec": "opus16k"])
        for frame in frames { connection.send(frame: frame) }
        connection.send(["type": "talk-end", "burstId": burstId])
    }
}

/// The relay the test runs against. At file scope: the suite's trait can't refer to the suite's
/// own type (a circular reference resolving the macro).
private let e2eRelay: URL? = ProcessInfo.processInfo.environment["OAO_E2E_RELAY"].flatMap(URL.init(string:))

/// Waits on the main actor, so the connections' callbacks run meanwhile.
@MainActor
private func pollUntil(seconds: Double, _ condition: @MainActor () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() {
        guard Date() < deadline else { throw CancellationError() }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
}
