import Foundation
import Testing
@testable import OverAndOutKit

/// The frozen v2 contract (contracts/ at the repository's root), as this build reads and writes
/// it. Every response example, today's and a later service's (Google accounts, Android and Wear
/// OS devices, unknown fields, values and events), must decode; what this build writes must
/// match the request examples; and the binary fixtures must parse and decode, real Apple Opus
/// packets included. The server checks the same files (server/test/contracts.test.ts).
struct ContractTests {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("contracts")

    static func data(_ path: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(path))
    }

    static func json(_ path: String) throws -> Any {
        try JSONSerialization.jsonObject(with: data(path))
    }

    /// Each element of a JSON array example, as its own data.
    static func elements(_ path: String) throws -> [Data] {
        try (json(path) as? [Any] ?? []).map { try JSONSerialization.data(withJSONObject: $0) }
    }

    @Test(arguments: ["examples/current/me.json", "examples/current/me-minimal.json", "examples/future/me-google.json", "examples/future/me-unknown-preference.json"])
    func theAccountDecodes(path: String) throws {
        let user = try JSONDecoder().decode(AccountUser.self, from: Self.data(path))
        #expect(user.id.hasPrefix("u_"))
        // What this build can't offer as a choice is left out of choices.
        #expect(user.knownFormFactors.allSatisfy { $0.isKnown })
    }

    @Test func aLaterServicesDeviceKindsAndPreferencesAreKeptAsUnknown() throws {
        let google = try JSONDecoder().decode(AccountUser.self, from: Self.data("examples/future/me-google.json"))
        #expect(google.signInProvider == "google")
        #expect(google.formFactors == [.phone, .watch, .unknown("glasses")])
        #expect(google.knownFormFactors == [.phone, .watch])
        // A mascot this build doesn't have draws the default.
        #expect(google.avatar.flatMap(Mascot.init(rawValue:)) == nil)
        let odd = try JSONDecoder().decode(AccountUser.self, from: Self.data("examples/future/me-unknown-preference.json"))
        #expect(odd.preferredFormFactor == .unknown("car"))
        #expect(odd.preferredFormFactor?.isKnown == false)
    }

    @Test(arguments: ["examples/current/friends.json", "examples/future/friends.json"])
    func friendsDecode(path: String) throws {
        struct Response: Decodable { let friends: [Friend] }
        let friends = try JSONDecoder().decode(Response.self, from: Self.data(path)).friends
        #expect(friends.count == 2)
    }

    @Test(arguments: ["examples/current/session-sign-in.json", "examples/future/session-sign-in.json"])
    func signInAnswersDecode(path: String) throws {
        // The shape AccountClient.signInWithApple reads.
        struct Response: Decodable { let token: String; let expiresAt: Double; let user: AccountUser; let created: Bool }
        let response = try JSONDecoder().decode(Response.self, from: Self.data(path))
        #expect(response.token.split(separator: ".").count == 3)
    }

    @Test(arguments: ["examples/current/relay-server-messages.json", "examples/future/relay-server-messages.json"])
    func everyRelayMessageDecodesAndUnknownOnesAreJustTypes(path: String) throws {
        for element in try Self.elements(path) {
            let message = try JSONDecoder().decode(RelayMessage.self, from: element)
            #expect(!message.type.isEmpty)
        }
        let messages = try Self.elements(path).map { try JSONDecoder().decode(RelayMessage.self, from: $0) }
        if let ring = messages.first(where: { $0.type == "ring" }) {
            let parsed = try #require(Ring(message: ring))
            #expect(parsed.ringId == "r_3qgS0mXPRkK8z1yA")
            #expect(parsed.expiresAt == 1_790_726_435_000)
        }
        if let error = messages.first(where: { $0.type == "error" }) { #expect(error.code != nil) }
    }

    @Test(arguments: ["examples/current/ring.json", "examples/future/ring.json"])
    func ringEnvelopesReadFromAPushPayload(path: String) throws {
        let payload = try #require(try Self.json(path) as? [String: Any])
        let ring = try #require(Ring(userInfo: payload))
        #expect(ring.ringId.hasPrefix("r_"))
        #expect(ring.expiresAt != nil)
        #expect(ring.pushSentAt != nil)
    }

    @Test func theServiceConfigDecodesAndOnlyAnApprovedRelayIsUsed() throws {
        let bundled = URL(string: "https://relay-1.overandout.app")!
        let suite = "contract-tests-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let old = ClientIdentity(kind: .ios, version: "1.0", build: "160")
        let store = ServiceConfigStore(bundledRelay: bundled, suiteName: suite, identity: old)
        #expect(store.relayBaseURL == bundled)
        #expect(store.update(with: try Self.data("examples/current/config.json")) != nil)
        #expect(store.relayBaseURL == bundled)
        #expect(!store.upgradeRequired)
        // A later config: another of our relays, a minimum this build is below, fields it doesn't know.
        #expect(store.update(with: try Self.data("examples/future/config.json")) != nil)
        #expect(store.relayBaseURL == URL(string: "https://relay-us.overandout.app"))
        #expect(store.upgradeRequired)
        #expect(ServiceConfigStore(bundledRelay: bundled, suiteName: suite, identity: old).upgradeRequired, "kept between launches")
        // Never a relay that isn't ours, nor garbage.
        #expect(store.update(with: Data(#"{"schemaVersion":1,"relay":{"baseUrl":"https://relay.example.com","protocols":[2],"audioFormats":[1],"codecs":["opus16k"]}}"#.utf8)) != nil)
        #expect(store.relayBaseURL == bundled)
        #expect(store.update(with: Data("not json".utf8)) == nil)
        #expect(ServiceConfigStore.approved(URL(string: "http://relay-2.overandout.app")!, bundled: bundled) == false)
        #expect(ServiceConfigStore.approved(URL(string: "https://evil-overandout.app")!, bundled: bundled) == false)
        // A relay that can't speak this build's protocol isn't used either.
        #expect(store.update(with: Data(#"{"schemaVersion":1,"relay":{"baseUrl":"https://relay-3.overandout.app","protocols":[3],"audioFormats":[1],"codecs":["opus16k"]}}"#.utf8)) != nil)
        #expect(store.relayBaseURL == bundled)
    }

    @Test(arguments: ["examples/current/errors.json", "examples/future/errors.json"])
    func errorsKeepTheirCodeAndMessage(path: String) throws {
        for element in try Self.elements(path) {
            let error = AccountAPIError(status: 409, body: element)
            #expect(!error.code.hasPrefix("http-"))
            #expect(error.errorDescription?.isEmpty == false)
            #expect(!error.endsSession || error.code == "session-ended")
        }
        let upgrade = AccountAPIError(status: 409, body: try Self.elements("examples/current/errors.json")[1])
        #expect(upgrade.requiresUpgrade)
        #expect(upgrade.minimumBuild == 170)
        #expect(!upgrade.endsSession)
    }

    @Test(arguments: ["examples/current/watch-link-session.json", "examples/future/watch-link-session.json"])
    func theWatchsSessionFromThePhoneDecodes(path: String) throws {
        let payload = try #require(try Self.json(path) as? [String: Any])
        let session = try #require(payload["session"] as? [String: Any])
        let decoded = try #require(WatchLink.decode(try JSONSerialization.data(withJSONObject: session)))
        #expect(decoded.clientKind == "watchos")
        #expect(decoded.parentDeviceId == "6c8f7e2a-1b3d-4e5f-9a7b-0c1d2e3f4a5b")
        #expect(payload[WatchLink.schemaVersion] as? Int ?? 0 >= WatchLink.currentSchemaVersion)
    }

    @Test(arguments: [
        ("examples/current/device-ios-pushtotalk.json", DeviceRegistration(delivery: .pushToTalk(token: "TOKEN", environment: "production"), notifications: .authorized), ClientKind.ios),
        ("examples/current/device-watchos-alert.json", DeviceRegistration(delivery: .alert(token: "TOKEN", environment: "production"), notifications: .authorized), ClientKind.watchos),
        ("examples/current/device-ios-foreground.json", DeviceRegistration(delivery: .foreground, notifications: .denied), ClientKind.ios),
    ])
    func registrationsAreWhatTheContractSays(path: String, registration: DeviceRegistration, kind: ClientKind) throws {
        let example = try #require(try Self.json(path) as? [String: Any])
        let identity = ClientIdentity(kind: kind, version: "1.0", build: "170", encodes: kind == .watchos ? ["opus16k", "pcm16le16k"] : ["opus16k"])
        let body = registration.body(identity: identity)
        #expect(body["clientKind"] as? String == example["clientKind"] as? String)
        var delivery = try #require(body["delivery"] as? [String: String])
        var expected = try #require(example["delivery"] as? [String: String])
        delivery["token"] = nil
        expected["token"] = nil
        #expect(delivery == expected)
        #expect(NSDictionary(dictionary: body["availability"] as? [String: Any] ?? [:]) == NSDictionary(dictionary: example["availability"] as? [String: Any] ?? [:]))
        if let capabilities = example["capabilities"] as? [String: Any] {
            let ours = try #require(body["capabilities"] as? [String: Any])
            for key in ["relayProtocols", "audioFormats", "decode", "encode"] {
                #expect(NSArray(array: ours[key] as? [Any] ?? []) == NSArray(array: capabilities[key] as? [Any] ?? []), "\(key)")
            }
        }
    }

    // MARK: Binary

    struct FrameFixture: Decodable {
        let name: String
        let valid: Bool
        let hex: String
        let codec: String?
        let seq: UInt32?
        let payloadBytes: Int?
    }

    static func bytes(_ hex: String) -> Data {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return data
    }

    @Test func framesParseAndRealAppleOpusDecodesWhileMalformedOnesDont() throws {
        struct File: Decodable { let format: Int; let frames: [FrameFixture] }
        let file = try JSONDecoder().decode(File.self, from: Self.data("fixtures/frames.json"))
        #expect(file.format == ServiceContract.audioFormat)
        let decoder = VoiceDecoder()
        var decodedOpus = 0
        for fixture in file.frames {
            let frame = Self.bytes(fixture.hex)
            let parsed = VoiceFrame.decode(frame)
            let audio = parsed.flatMap { decoder.decode(codec: $0.codec, payload: $0.payload) }
            if fixture.valid {
                let parsed = try #require(parsed, "\(fixture.name)")
                #expect(parsed.seq == fixture.seq, "\(fixture.name)")
                #expect(parsed.payload.count == fixture.payloadBytes, "\(fixture.name)")
                #expect(parsed.codec == (fixture.codec == "opus16k" ? .opus16k : .pcm16le16k), "\(fixture.name)")
                if parsed.codec == .opus16k, VoiceEncoder.makeOpusFormat() != nil {
                    #expect(audio != nil, "\(fixture.name) didn't decode")
                    decodedOpus += 1
                }
            } else {
                // Unknown codecs don't parse; wrong sizes parse but never reach the speaker.
                #expect(audio == nil, "\(fixture.name) decoded")
            }
        }
        if VoiceEncoder.makeOpusFormat() != nil { #expect(decodedOpus == 4) }
    }

    @Test func recordsParseWholeAndAcrossChunks() throws {
        struct Record: Decodable { let name: String; let type: String?; let hex: String?; let chunks: [String]?; let records: [String]?; let valid: Bool? }
        struct File: Decodable { let records: [Record] }
        let records = try JSONDecoder().decode(File.self, from: Self.data("fixtures/records.json")).records
        let types = Dictionary(uniqueKeysWithValues: records.map { ($0.name, $0.type) })
        for record in records {
            var parser = RelayRecord.Parser()
            if let chunks = record.chunks {
                let parsed = try chunks.flatMap { try parser.push(Self.bytes($0)) }
                #expect(parsed.map { $0.type == RelayRecord.json ? "json" : "audio" } == record.records?.compactMap { types[$0] ?? nil })
            } else if record.valid == false {
                #expect(throws: (any Error).self, "\(record.name)") { try parser.push(Self.bytes(record.hex!)) }
            } else {
                let parsed = try parser.push(Self.bytes(record.hex!))
                #expect(parsed.count == 1)
            }
        }
    }
}
