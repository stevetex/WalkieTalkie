# Over&Out character collection

Eighteen characters based on the approved lineup and subsequent additions. Open [preview.html](preview.html) to compare transparent artwork, iPhone and circular Watch previews, and 48-pixel icon exports. Each numbered folder is a self-contained asset set. All 18 characters are available in the iPhone avatar picker, with matching avatar artwork bundled in both apps.

Character 04 has a dusty rose pink ribbon, and 05 uses the same pink in its rabbit ears. Characters 16 and 17 are honey and cocoa versions of 04, both with pink ribbons. The pink target is `#D982A2`; highlight and shadow targets are in `palette.json`. Orange side buttons are retained. The reference lineup records the earlier sketches and therefore predates these updates.

## Choose a file

| Purpose | File inside each character folder |
| --- | --- |
| Reusable transparent original | `master.png` |
| In-app image at 256 points | `app/CharacterArt.xcassets` with 256/512/768-pixel images |
| Full-color merchandise | `merch/color-300dpi.png` |
| Square icon source | `icons/icon-1024.png` |
| iPhone icon asset catalog | `icons/iPhone.xcassets` |
| Watch icon asset catalog | `icons/Watch.xcassets` |
| Small previews / other tooling | `icons/exports/` with 48, 96, 180, 256 and 512-pixel PNGs |

`characters.json` maps the stable folder IDs, names and unique Xcode asset names. `manifest.json` records PNG dimensions, alpha, DPI and SHA-256 hashes. The approved sketch sheet is preserved in `reference/approved-lineup.png`.

## App integration

The shared `Mascot` enum supplies the avatar picker and stored IDs. Each app bundles a matching `Mascot<Name>` imageset under `Assets.xcassets/Mascots`. Character 18, Pirate, uses the stored ID `pirate` and image name `MascotPirate`. Its eyepatch covers the viewer-right eye beside the orange button. The iPhone avatar is 288 pixels at 3×; the Watch avatar is 96 pixels at 2×, matching the existing collection.

Import the desired `CharacterArt.xcassets` catalogs into the appropriate app target. Every imageset has a unique name, such as `OAOBookworm`, so multiple character catalogs can coexist. Preserve aspect ratio and allow room for antennas and accessories. Use native accessible text to name a selectable character; the PNGs contain no labels.

For icons, import the platform-specific catalog into the corresponding target. Icon sets have unique names such as `OAOBookwormIcon`. The supplied square 1024-pixel icons are opaque; let the system apply the platform mask. They are conventional flat PNG asset catalogs, not layered Icon Composer documents. Dedicated dark/tinted variants are not included.

On iPhone, include the intended icon sets in the target's Alternate App Icon Sets build setting and implement the selection UI/API separately. Merely adding these art files does not enable switching. On Watch, choose an icon set as the build's primary app icon; watchOS does not provide the iPhone runtime alternate-icon picker API. The same characters remain usable as selectable in-app avatars on both platforms.

Apple references: [asset-catalog icons](https://developer.apple.com/documentation/xcode/configuring-your-app-icon), [alternate icon configuration](https://developer.apple.com/documentation/xcode/configuring-your-app-to-use-alternate-app-icons), [platform availability and icon design](https://developer.apple.com/design/human-interface-guidelines/app-icons).

## Merchandise

Print PNGs retain the transparent master's native pixels and add 300 DPI metadata; they are not upscaled. Consult `characters.json` for native canvas dimensions. At 300 DPI, a 1254-pixel canvas is 4.18 inches wide; the visible character is smaller because the canvas includes clear margins. Use these for stickers, mugs and small apparel graphics. Larger prints need a vector redraw or a higher-resolution master, not a DPI metadata change.

These are full-color RGB PNGs, with no cut contours, bleed, color separations, embroidery stitching or vendor templates. A print shop can prepare its required production format. No one-color artwork is included in this set.

## Provenance and visual consistency

The built-in image generation tool produced an individual transparent master for each approved character, then an opaque indigo icon adaptation from that master. Image edits were performed with that tool. macOS `sips` produced size and DPI exports. The icon adaptations may have small rendering differences from the transparent masters; they are not claimed to be pixel-identical composites. Generated indigo backgrounds can contain slight color variation. Fox's and Morticia's icons are the exception: since October 1, 2026 they are composited from their masters by `icon-from-master.swift` (see GENERATION.md).

Exact generation prompts are in [GENERATION.md](GENERATION.md). Validation results are in [VALIDATION.md](VALIDATION.md). All artwork is raster; no SVG, editable layers or vector source is implied.
