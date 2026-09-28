import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Profile photos (design decision 2026-09-27): a 256 px square JPEG per account, uploaded by
/// its owner and downloaded by friends. Each device keeps the latest version of each photo in
/// Caches and downloads again only when a friend list shows a newer `photoVersion`.
public actor PhotoCache {
    public static let shared = PhotoCache()

    private let directory: URL
    private var memory: [String: Data] = [:]
    private var inFlight: [String: Task<Data?, Never>] = [:]

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = caches.appendingPathComponent("ProfilePhotos", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// The photo for `userId` at `version`, from memory, disk or `download`. Nil if there's
    /// none or the download fails (the caller shows the initial instead).
    public func photo(userId: String, version: Double, download: @escaping @Sendable () async throws -> Data) async -> Data? {
        let key = "\(userId)-\(Int64(version))"
        if let data = memory[key] { return data }
        let file = directory.appendingPathComponent("\(key).jpg")
        if let data = try? Data(contentsOf: file) {
            memory[key] = data
            return data
        }
        if let task = inFlight[key] { return await task.value }
        let task = Task<Data?, Never> { try? await download() }
        inFlight[key] = task
        let data = await task.value
        inFlight[key] = nil
        if let data {
            memory[key] = data
            removeOlder(than: key, userId: userId)
            try? data.write(to: file, options: .atomic)
        }
        return data
    }

    /// After your own upload: keep it without downloading it back.
    public func store(_ data: Data, userId: String, version: Double) {
        let key = "\(userId)-\(Int64(version))"
        memory[key] = data
        removeOlder(than: key, userId: userId)
        try? data.write(to: directory.appendingPathComponent("\(key).jpg"), options: .atomic)
    }

    private func removeOlder(than key: String, userId: String) {
        for old in memory.keys where old.hasPrefix("\(userId)-") && old != key { memory[old] = nil }
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in files where name.hasPrefix("\(userId)-") && name != "\(key).jpg" {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }
}

/// A person's picture in a circle: their photo, their chosen mascot, or the default mascot
/// (design decision 2026-09-28). While a photo loads, a plain indigo circle.
public struct Avatar: View {
    let name: String
    let userId: String
    let photoVersion: Double?
    let avatar: String?
    let size: CGFloat
    let client: AccountClient?

    @State private var photo: Image?

    public init(name: String, userId: String, photoVersion: Double?, avatar: String? = nil, size: CGFloat, client: AccountClient?) {
        self.name = name
        self.userId = userId
        self.photoVersion = photoVersion
        self.avatar = avatar
        self.size = size
        self.client = client
    }

    public init(friend: Friend, size: CGFloat, client: AccountClient?) {
        self.init(name: friend.name, userId: friend.id, photoVersion: friend.photoVersion, avatar: friend.avatar, size: size, client: client)
    }

    public var body: some View {
        ZStack {
            if let photo {
                photo.resizable().scaledToFill()
            } else if photoVersion != nil {
                Circle().fill(Brand.indigo)
            } else {
                Image((Mascot(id: avatar) ?? .default).imageName)
                    .resizable()
                    .scaledToFill()
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: photoVersion) { await load() }
    }

    private func load() async {
        guard let version = photoVersion, let client else {
            photo = nil
            return
        }
        let userId = userId
        let data = await PhotoCache.shared.photo(userId: userId, version: version) {
            try await client.photo(userId: userId)
        }
        #if canImport(UIKit)
        photo = data.flatMap(UIImage.init(data:)).map(Image.init(uiImage:))
        #endif
    }
}

#if os(iOS)
/// Only the iPhone uploads photos (UIGraphicsImageRenderer isn't on watchOS).
public enum ProfilePhoto {
    /// The side of the uploaded square, in pixels.
    public static let side: CGFloat = 256

    /// A centre-cropped 256 px square JPEG, under the server's 100 KB limit.
    public static func jpeg(from image: UIImage) -> Data? {
        let source = image.size
        guard source.width > 0, source.height > 0 else { return nil }
        let scale = side / min(source.width, source.height)
        let drawn = CGSize(width: source.width * scale, height: source.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let square = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            image.draw(in: CGRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
        for quality in [0.8, 0.65, 0.5, 0.35] {
            if let data = square.jpegData(compressionQuality: quality), data.count <= 100 * 1024 { return data }
        }
        return nil
    }
}
#endif
