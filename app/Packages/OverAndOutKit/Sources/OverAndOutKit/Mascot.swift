import Foundation

/// The built-in mascot pictures (art/characters), which people can pick instead of a photo
/// (design decision 2026-09-28). The account stores the ID; each app bundles the art as
/// "Mascot<Name>" in its asset catalog (Assets.xcassets/Mascots). Anyone without a photo or
/// a mascot, or with a mascot this build doesn't know, shows `default`.
public enum Mascot: String, CaseIterable, Identifiable, Sendable {
    case porcelain
    case honey
    case cocoa
    case bowLashes = "bow-lashes"
    case bunny
    case bookworm
    case mustachio
    case toughGuy = "tough-guy"
    case manga
    case coolCat = "cool-cat"
    case fox
    case hiFi = "hi-fi"
    case frankenstein
    case dracula
    case morticia
    case bowLashesHoney = "bow-lashes-honey"
    case bowLashesCocoa = "bow-lashes-cocoa"

    public static let `default` = Mascot.honey

    public var id: String { rawValue }

    /// A known mascot for a stored ID, or nil.
    public init?(id: String?) {
        guard let id, let mascot = Mascot(rawValue: id) else { return nil }
        self = mascot
    }

    public var name: String {
        switch self {
        case .porcelain: return "Porcelain"
        case .honey: return "Honey"
        case .cocoa: return "Cocoa"
        case .bowLashes: return "Bow & Lashes"
        case .bunny: return "Bunny"
        case .bookworm: return "Bookworm"
        case .mustachio: return "Mustachio"
        case .toughGuy: return "Tough Guy"
        case .manga: return "Manga"
        case .coolCat: return "Cool Cat"
        case .fox: return "Fox"
        case .hiFi: return "Hi-Fi"
        case .frankenstein: return "Frankenstein"
        case .dracula: return "Dracula"
        case .morticia: return "Morticia"
        case .bowLashesHoney: return "Honey Bow & Lashes"
        case .bowLashesCocoa: return "Cocoa Bow & Lashes"
        }
    }

    /// The square picture on indigo in each app's asset catalog.
    public var imageName: String {
        "Mascot" + rawValue.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }
}
