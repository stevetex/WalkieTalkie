// swift-tools-version: 6.2
// Code shared by the iPhone and watch apps: the relay transport, the voice codec and the
// audio pipeline, ported from the spike (watch/WalkieSpike). macOS is listed only so
// `swift test` can run the tests on a Mac.
//
// iOS 16 / watchOS 9 is the lowest Xcode 27 can target for watchOS, and a watch on
// watchOS 9 pairs with an iPhone on iOS 16 or later. Keep these in step with the app
// targets' deployment targets.

import PackageDescription

let package = Package(
    name: "OverAndOutKit",
    platforms: [.iOS("16.0"), .watchOS("9.0"), .macOS("26.0")],
    products: [
        .library(name: "OverAndOutKit", targets: ["OverAndOutKit"]),
    ],
    targets: [
        .target(name: "OverAndOutKit", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(
            name: "OverAndOutKitTests",
            dependencies: ["OverAndOutKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
