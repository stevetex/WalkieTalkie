// swift-tools-version: 6.2
// Code shared by the iPhone and watch apps: the relay transport, the voice codec and the
// audio pipeline, ported from the spike (watch/WalkieSpike, since removed). macOS is listed only so
// `swift test` can run the tests on a Mac.
//
// watchOS 10.2 and iOS 17 are the oldest versions Xcode 27's simulators run here, so the
// oldest we can test (design decision 2026-10-01); a watch on watchOS 10 pairs with an
// iPhone on iOS 17 or later. Keep these in step with the app targets' deployment targets.

import PackageDescription

let package = Package(
    name: "OverAndOutKit",
    platforms: [.iOS("17.0"), .watchOS("10.2"), .macOS("26.0")],
    products: [
        .library(name: "OverAndOutKit", targets: ["OverAndOutKit"]),
    ],
    targets: [
        .target(name: "OverAndOutKit", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(
            name: "OverAndOutKitTests",
            dependencies: ["OverAndOutKit"],
            // The speech clip the audio tests measure (Fixtures/speech-16k.wav).
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
