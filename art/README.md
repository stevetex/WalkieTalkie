# Nowza artwork

Approved direction: **09 — Chrome Tomorrow**, with rotary knob eyes and an oversized circular speaker mouth. September 27, 2026.

The [18-character collection](characters/README.md) adds individual transparent masters, app image catalogs, full-color merch exports, and iPhone/Watch icon catalogs. Browse its [preview gallery](characters/preview.html).

Open [preview.html](preview.html) to browse the artwork, see approximate iPhone and circular Watch masks, and compare small sizes. All assets and documentation are contained in this directory. The iPhone and Watch apps now embed copies of the icon and stacked-wordmark assets. Their semantic light/dark palettes are in each app’s `Assets.xcassets`, and shared color accessors are in `OverAndOutKit/Brand.swift`.

## Choose the right file

| Use | File or directory |
| --- | --- |
| iPhone app icon / App Store | `icons/iPhone.xcassets/AppIcon.appiconset/OverAndOut-1024.png` |
| Apple Watch app icon / App Store | `icons/Watch.xcassets/AppIcon.appiconset/OverAndOut-1024.png` |
| Reusable transparent character | `masters/mascot-color.png` |
| The iPhone's Talk-screen mascot (the app's `OverAndOutMascot` crop, x 262–1024, y 36–1220, upscaled 2× with MetalFX by `upscale-art.swift`) | `masters/mascot-talk-2x.png` |
| Adaptive welcome / About layout | `screens/ScreenArt.xcassets/OverAndOutMascot.imageset/` |
| Composed welcome / About artwork | `screens/about-welcome-1024.png` |
| Documentation header / light-background logo | `documentation/over-and-out-horizontal-1200.png` |
| Small documentation header | `documentation/over-and-out-horizontal-600.png` |
| Large documentation header | `documentation/over-and-out-horizontal-1800.png` |
| Documentation avatar | `documentation/over-and-out-avatar-512.png` |
| Full-color stickers, mugs, small apparel prints | `merch/mascot-color-300dpi.png` |
| Black-ink printing on light stock | `merch/mascot-ink-black-300dpi.png` |
| Horizontal logo for light merchandise | `merch/lockup-horizontal-dark-300dpi.png` |

## Icons and Xcode

The iPhone and Watch catalogs each contain an opaque **1024 × 1024 PNG**, with square corners and an indigo background. Both use the same artwork. Apple applies the platform mask; do not pre-round these source files or replace them with the transparent mascot.

Import the iPhone catalog into the iPhone target and the Watch catalog into the Watch target. Each has an `AppIcon` set, so keep target membership separate. Choose `AppIcon` as the target's app icon source. These are conventional flat asset catalogs, not layered Icon Composer documents.

Modern Xcode generates the required device sizes from the single 1024-pixel source. `icons/exports/` provides additional convenience PNG sizes for previews and other tooling; those files do not need to be imported individually. Custom dark/tinted appearance variants are not supplied.

The catalogs were independently compiled with Xcode 27 `actool` for the project's minimum versions, iOS 16 and watchOS 9. The screen-art catalog also compiled. The sandbox emitted CoreSimulator service diagnostics, but all three asset compilations returned success and produced `Assets.car`. This was asset validation, not an app build or simulator installation.

Sources: [Apple: configuring an app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon), [Apple: app icon design](https://developer.apple.com/design/human-interface-guidelines/app-icons).

## Welcome and About screens

`ScreenArt.xcassets` contains:

- `OverAndOutMascot`: transparent PNGs at 256, 512 and 768 pixels, representing a 256-point image at 1×, 2× and 3×.
- `OverAndOutBrand`: the stacked mascot and ivory wordmark on opaque indigo, at the same scales.

Use the separate mascot with native text for flexible layouts and accessibility. Preserve its aspect ratio and leave room around the antenna. The stacked composition works as an About illustration or welcome panel; its indigo background contains slight generated color variation, so do not assume a seamless flat-color edge. These are artwork components, not complete screen implementations or launch-screen storyboards. Let text, controls and safe-area spacing adapt to the device.

## Documentation and wordmark

The horizontal lockup has a transparent background and dark lettering, intended for white, ivory or other light backgrounds. Its native master is **2172 × 724 px**. The supplied wordmark is raster artwork; there is no associated font file or editable typeface. Brand spelling is **Nowza**.

The name-bearing masters and exports were updated on October 9, 2026. Run `bash art/export-brand.sh` from the repo to refresh screen catalogs, copies in both apps, website mastheads, documentation headers and the merch lockup from the two masters. Legacy filenames (`over-and-out-horizontal-*`) and asset names (`OverAndOutBrand`) remain stable; their visible lettering now says Nowza. Icons and standalone mascots contain no product lettering. Historical reference boards retain the original name.

The preview is a local HTML document with relative image paths. Keep the `art` directory intact when sharing it. It does not require a network connection.

## Merchandise and print limits

The print files are transparent PNGs with **300 DPI metadata**, copied from native-resolution artwork without upscaling. DPI metadata describes print size; it does not add detail.

| Artwork | Native canvas | Canvas size at 300 DPI |
| --- | --- | --- |
| Full-color mascot | 1254 × 1254 px | 4.18 × 4.18 in / 106 × 106 mm |
| Black-ink mascot | 1254 × 1254 px | 4.18 × 4.18 in / 106 × 106 mm |
| Horizontal lockup | 2172 × 724 px | 7.24 × 2.41 in / 184 × 61 mm |

Visible artwork is smaller than the canvas because it includes transparent margins. These files suit stickers, mug graphics and small chest prints. Large shirt-front prints, signage, cutting, and embroidery need a vector redraw or a higher-resolution production master; resizing these PNGs alone will not create that detail.

The black-ink adaptation uses transparent negative space and near-black antialiased artwork. Have the printer separate it to one spot ink and proof minimum line widths. It is not a pre-separated plate or embroidery stitch file. Full-color printing on dark material may require a white underbase. No bleed, dieline, cut contour, CMYK separation or vendor-specific template is included.

## Design handling

Keep the knob eyes, circular speaker mouth, tapered silver casing, angled antenna and orange side button together. Avoid stretching, cropping the antenna, adding a smile, or placing dark lettering on indigo. Maintain clear space around the character; a knob diameter is a useful minimum outside the supplied art bounds.

Target palette is in `palette.json`: indigo `#272D50`, ivory `#FFF6DF`, ink `#10161B`, silver blue `#BED5DF`, talk orange `#FF8B1A`. The generated illustrations include shading, so these are palette targets rather than exact colors for every pixel.

## Files and provenance

- `masters/`: native-resolution artwork; start here for future exports.
- `icons/`: importable app icon catalogs and convenience exports.
- `favicon.swift`: the website's favicons (`web/public/favicon.ico`, `img/favicon-32.png`, `img/favicon-192.png`) from `masters/mascot-color.png`: `swift art/favicon.swift`.
- `screens/`: screen artwork and a reusable Xcode image catalog.
- `documentation/`: horizontal logo and avatar exports.
- `merch/`: native-resolution transparent artwork tagged 300 DPI.
- `reference/`: the approved concept board, for reference only.
- `GENERATION.md`: built-in image tool provenance and the final prompt set.
- `manifest.json`: dimensions, alpha modes, DPI metadata and SHA-256 hashes.
- `VALIDATION.md`: completed asset checks and scope.

Generated artwork adaptations preserve the design but are not pixel-identical composites of one source drawing. All delivered artwork is raster; no vector or layered source is claimed.
