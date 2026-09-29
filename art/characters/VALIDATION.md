# Character asset validation

## Original 17-character delivery — September 27, 2026

- All 17 characters have a transparent native 1254 × 1254 master, a print export, a 1×/2×/3× imageset, and iPhone/Watch icon catalogs.
- 222 PNGs total, including the approved lineup; dimensions, modes and hashes are recorded in `manifest.json`.
- Transparent masters contain genuine alpha, with clear space on every edge. All print exports preserve the master's decoded pixels exactly and carry 300 DPI metadata.
- All icon sources are opaque 1024 × 1024 PNGs. Target-specific catalogs contain identical icon artwork for each character.
- Every catalog JSON image reference resolves to an existing file.
- Xcode 27 `actool` compiled all 17 iPhone icon catalogs for iOS 16 and all 17 Watch icon catalogs for watchOS 9. All 17 in-app image catalogs also compiled together. Every compilation returned success and produced `Assets.car`; results are in `catalog-validation.json`. CoreSimulator sandbox diagnostics did not prevent asset compilation.
- Inspected all individual masters and all icon variants, plus the browser gallery's circular Watch masks and 48-pixel previews. All 68 images in the expanded gallery loaded successfully.
- Fox and Morticia icon compositions were reduced after the first mask check caught edge clipping; their revised catalogs were compiled again.
- A foreground-versus-background pixel check found no foreground outside a centered 510-pixel-radius circle in any final 1024-pixel icon. This uses a 25-channel-value threshold against the corner background color; it is a geometric sanity check, not an exact OS mask simulation. Results are in `pixel-validation.json`.

This is asset validation. No app implementation, runtime icon switching, signed device build, App Store submission, or physical print proof was performed. Print sizes are limited by native raster resolution as described in README.md.

## Pink accessory update

Characters 04 and 05 were updated, and 16 Honey and 17 Cocoa bow variants were added. Their eight iPhone/Watch catalogs were compiled again, and all 17 in-app image catalogs were compiled together. Transparency, print pixel preservation, icon opacity, file references and circle bounds passed. SHA-256 comparison confirmed that PNGs for the other 13 characters were unchanged.

## Pirate addition — September 28, 2026

- The collection now contains 18 characters and 235 PNGs, including the earlier lineup. Pirate has a transparent 1254 × 1254 master, pixel-identical 300 DPI print export, 256/512/768-pixel app artwork, opaque 1024-pixel icon catalogs for both platforms, and 48/96/180/256/512-pixel icon exports.
- Pirate's alpha has clear margins on all edges. Its icon foreground stays within the circular crop check: maximum radius 492.27 pixels, with zero foreground pixels outside radius 510.
- Both new icon catalogs compiled successfully with `actool`, as did all 18 in-app image catalogs together. The cumulative catalog report contains 37 successful entries.
- All 222 previously delivered PNGs retain their SHA-256 hashes. All 72 gallery image references resolve; the newly generated master, icon and 96-pixel Watch avatar were visually inspected.
- All 18 avatar IDs resolve to imagesets in both app targets. Pirate's bundled iPhone and Watch images follow the existing 288-pixel/3× and 96-pixel/2× conventions.
- `swift test --filter MascotTests` passed all four tests, including the pirate ID and image name checks.
- `xcodebuild -project app/OverAndOut.xcodeproj -scheme OverAndOut -destination 'generic/platform=iOS Simulator' -derivedDataPath /private/tmp/oao-pirate-build CODE_SIGNING_ALLOWED=NO build` succeeded for the iPhone app and embedded Watch app. Both generated asset symbol files include `MascotPirate`. Warnings in unchanged concurrency code remain.

The avatar picker consumes `Mascot.allCases`, which now includes Pirate. No signed device build, live account selection test, runtime app-icon switching, or physical print proof was performed for this addition.
