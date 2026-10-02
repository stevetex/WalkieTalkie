import Foundation
import os

// The v2 service contract (contracts/README.md; Phase 0 of ANDROID_WEAR_OS_PLAN.md) as the apps
// speak it. A build that speaks it must keep working when the service adds Android and Wear OS,
// so what the service describes is read tolerantly: unknown fields are ignored, and a value
// these types don't know (a later device kind, a form factor) decodes as `.unknown` instead of
// failing the whole response. What the app writes is only ever what it knows.

public enum ServiceContract {
    /// The account API's version: the path prefix.
    public static let apiVersion = 2
    /// The relay protocol, said at admission (X-OAO-Relay-Protocol).
    public static let relayProtocol = 2
    /// The binary audio format (unchanged since the spike).
    public static let audioFormat = 1
    /// The ring envelope's, the watch link's and the prefetch metadata's.
    public static let schemaVersion = 2
    /// Every build plays both codecs (the contract requires it).
    public static let decodes = ["opus16k", "pcm16le16k"]
    /// Posted when the service says this build is too old (client-upgrade-required), from the
    /// API or the relay: the app shows "Update Over&Out" and keeps the session.
    public static let upgradeRequiredNotification = Notification.Name("OverAndOutUpgradeRequired")
}

/// A kind of device, as the contract names it. Ones a later service adds (`.unknown`) are never
/// selectable.
public enum ClientKind: Hashable, Sendable, Codable, CustomStringConvertible {
    case ios, watchos, android, wearos
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "ios": self = .ios
        case "watchos": self = .watchos
        case "android": self = .android
        case "wearos": self = .wearos
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .ios: "ios"
        case .watchos: "watchos"
        case .android: "android"
        case .wearos: "wearos"
        case let .unknown(value): value
        }
    }

    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// The watch kind a phone of this kind makes sessions for.
    public var companion: ClientKind? {
        switch self {
        case .ios: .watchos
        case .android: .wearos
        default: nil
        }
    }
}

/// Which kind of device rings: a phone or a watch. Unknown ones (`.unknown`) are left out of
/// choices.
public enum FormFactor: Hashable, Sendable, Codable, CustomStringConvertible {
    case phone, watch
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "phone": self = .phone
        case "watch": self = .watch
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .phone: "phone"
        case .watch: "watch"
        case let .unknown(value): value
        }
    }

    public var description: String { rawValue }

    public var isKnown: Bool {
        if case .unknown = self { return false }
        return true
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// This build, as it tells the service: its kind, version and build number. Metadata for
/// compatibility and diagnostics, never authentication.
public struct ClientIdentity: Sendable, Equatable {
    public var kind: ClientKind
    public var version: String
    public var build: String
    /// Codecs this device may send: Opus, or PCM where the Opus encoder isn't available.
    public var encodes: [String]

    public init(kind: ClientKind, version: String, build: String, encodes: [String] = ["opus16k", "pcm16le16k"]) {
        self.kind = kind
        self.version = version
        self.build = build
        self.encodes = encodes
    }

    /// This app: an iPhone or a watch (the watch's extension too).
    public static let current: ClientIdentity = {
        #if os(watchOS)
        let kind = ClientKind.watchos
        #else
        let kind = ClientKind.ios
        #endif
        let info = Bundle.main.infoDictionary ?? [:]
        return ClientIdentity(kind: kind,
                              version: info["CFBundleShortVersionString"] as? String ?? "0",
                              build: info["CFBundleVersion"] as? String ?? "0")
    }()

    /// On every account API call.
    public var apiHeaders: [String: String] {
        ["X-OAO-Client-Kind": kind.rawValue, "X-OAO-Client-Version": version, "X-OAO-Build": build]
    }

    /// On relay admission: the stream, the WebSocket and the ring calls.
    public var relayHeaders: [String: String] {
        apiHeaders.merging([
            "X-OAO-Relay-Protocol": String(ServiceContract.relayProtocol),
            "X-OAO-Decode": ServiceContract.decodes.joined(separator: ","),
            "X-OAO-Encode": encodes.joined(separator: ","),
        ]) { $1 }
    }

    /// The build as a number, for comparing with a minimum (0 if it isn't one).
    public var buildNumber: Int { Int(build) ?? 0 }
}

// MARK: - Device registration

/// What PUT /v2/me/device says about this device: how it's rung, whether notifications are on,
/// and what it can play. The only deliveries an Apple build can name are the ones it can be rung
/// by (the server refuses anything else anyway).
public struct DeviceRegistration: Sendable, Equatable {
    public enum Delivery: Sendable, Equatable {
        /// An iPhone in its PushToTalk channel: the message plays at once.
        case pushToTalk(token: String, environment: String)
        /// A watch: a time-sensitive alert, tapped to listen.
        case alert(token: String, environment: String)
        /// Rung only over this device's open relay stream (an app on screen).
        case foreground

        var json: [String: String] {
            switch self {
            case let .pushToTalk(token, environment): ["provider": "apns", "mode": "pushtotalk", "token": token, "environment": environment]
            case let .alert(token, environment): ["provider": "apns", "mode": "alert", "token": token, "environment": environment]
            case .foreground: ["provider": "relay", "mode": "foreground"]
            }
        }

        /// For telemetry: never the token.
        public var label: String {
            switch self {
            case .pushToTalk: "pushtotalk"
            case .alert: "alert"
            case .foreground: "foreground"
            }
        }
    }

    public enum Notifications: String, Sendable {
        case authorized, denied, unknown
    }

    public var delivery: Delivery
    public var notifications: Notifications
    public var enabled: Bool

    public init(delivery: Delivery, notifications: Notifications, enabled: Bool = true) {
        self.delivery = delivery
        self.notifications = notifications
        self.enabled = enabled
    }

    /// The request body, for this build.
    public func body(identity: ClientIdentity) -> [String: Any] {
        [
            "clientKind": identity.kind.rawValue,
            "delivery": delivery.json,
            "availability": ["enabled": enabled, "notifications": notifications.rawValue],
            "capabilities": [
                "relayProtocols": [ServiceContract.relayProtocol],
                "audioFormats": [ServiceContract.audioFormat],
                "decode": ServiceContract.decodes,
                "encode": identity.encodes,
                "features": [String](),
            ] as [String: Any],
            "clientVersion": identity.version,
            "build": identity.build,
        ]
    }
}

// MARK: - Configuration

/// GET /v2/config: the service's versions, the relay to use, and the lowest supported builds.
/// Fetched at launch and on coming to the front, never on the ring path.
public struct ServiceConfig: Codable, Sendable, Equatable {
    public struct Relay: Codable, Sendable, Equatable {
        public let baseUrl: String
        public let protocols: [Int]
        public let audioFormats: [Int]
        public let codecs: [String]
    }

    public struct Compatibility: Codable, Sendable, Equatable {
        public let minimumBuilds: [String: Int]?
        public let message: String?
    }

    public let schemaVersion: Int
    public let relay: Relay?
    public let features: [String: Bool]?
    public let compatibility: Compatibility?

    /// The lowest build of this kind the service still supports, if it says.
    public func minimumBuild(for kind: ClientKind) -> Int? {
        compatibility?.minimumBuilds?[kind.rawValue]
    }
}

/// The last good config, kept between launches (in the app group when there is one, so the
/// watch's notification extension sees the same relay), and the decisions made from it.
public final class ServiceConfigStore: Sendable {
    public static let relayKey = "oaoApprovedRelayBaseURL"
    private static let configKey = "oaoServiceConfig"

    /// The app group's defaults, or the app's own (UserDefaults isn't Sendable, so not stored).
    private let suiteName: String?
    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }
    private let bundledRelay: URL?
    private let identity: ClientIdentity
    private let state: OSAllocatedUnfairLock<ServiceConfig?>

    /// `bundledRelay`: the relay in this build's Info.plist, used until (and unless) the service
    /// names another approved one. `suiteName`: the app group, if any.
    public init(bundledRelay: URL?, suiteName: String? = nil, identity: ClientIdentity = .current) {
        let defaults = suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
        self.suiteName = suiteName
        self.bundledRelay = bundledRelay
        self.identity = identity
        let saved = defaults.data(forKey: Self.configKey).flatMap { try? JSONDecoder().decode(ServiceConfig.self, from: $0) }
        state = OSAllocatedUnfairLock(initialState: saved)
    }

    public var config: ServiceConfig? { state.withLock { $0 } }

    /// The relay to connect to: the service's, when it's approved, speaks this build's relay
    /// protocol and audio format and plays a codec this build sends; otherwise this build's own.
    public var relayBaseURL: URL? {
        guard let relay = config?.relay, let url = URL(string: relay.baseUrl), Self.approved(url, bundled: bundledRelay),
              relay.protocols.contains(ServiceContract.relayProtocol), relay.audioFormats.contains(ServiceContract.audioFormat),
              !Set(relay.codecs).isDisjoint(with: identity.encodes) else { return bundledRelay }
        return url
    }

    /// The service no longer supports this build: show "Update Over&Out" (and keep the session).
    public var upgradeRequired: Bool {
        guard let minimum = config?.minimumBuild(for: identity.kind) else { return false }
        return identity.buildNumber < minimum
    }

    /// The service's own words for the update screen, if it has any.
    public var upgradeMessage: String? { config?.compatibility?.message }

    /// The relay host is ours: the bundled relay, or HTTPS on overandout.app or a host under it.
    /// A build pointed at this Mac (the simulator) only ever uses its own.
    public static func approved(_ url: URL, bundled: URL?) -> Bool {
        if let bundled, url.host == bundled.host, url.scheme == bundled.scheme, url.port == bundled.port { return true }
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        if let bundledHost = bundled?.host, bundledHost == "localhost" || bundledHost == "127.0.0.1" { return false }
        return host == "overandout.app" || host.hasSuffix(".overandout.app")
    }

    /// Takes a config the service sent (GET /v2/config), keeping it for later launches. A config
    /// that doesn't decode is ignored: the last good one stays.
    @discardableResult
    public func update(with data: Data) -> ServiceConfig? {
        guard let config = try? JSONDecoder().decode(ServiceConfig.self, from: data) else { return nil }
        state.withLock { $0 = config }
        defaults.set(data, forKey: Self.configKey)
        defaults.set(relayBaseURL?.absoluteString, forKey: Self.relayKey)
        return config
    }

    /// Fetches GET /v2/config from the account API. Failures keep the last good config.
    public func refresh(apiBase: URL, urlSession: URLSession = .shared) async {
        var request = URLRequest(url: apiBase.appendingPathComponent("v2/config"), timeoutInterval: 15)
        for (name, value) in identity.apiHeaders { request.setValue(value, forHTTPHeaderField: name) }
        guard let (data, response) = try? await urlSession.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return }
        update(with: data)
    }
}
