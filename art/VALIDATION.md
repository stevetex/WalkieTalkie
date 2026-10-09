# Asset validation

## Nowza wordmarks — October 9, 2026

- Replaced both name-bearing masters and refreshed their exports: 18 images across `art/`, the iPhone and Watch catalogs, and website logos. `rename-validation.json` records the affected paths; 337 other inventoried images are unchanged.
- The stacked master is opaque RGB, 1254 × 1254. Its welcome/About export is 1024 × 1024; app catalog exports remain 256/512/768 px at 1×/2×/3×.
- The horizontal master is RGBA, 2172 × 724, with genuine transparency. Documentation exports retain alpha at 600/1200/1800 px wide. The merch copy retains the master's exact pixels with 300 DPI metadata; no master was enlarged.
- iPhone and Watch catalog copies match the screen-art exports byte for byte. Catalog and preview references resolve. `manifest.json` records current dimensions, modes, DPI and hashes for all 42 production art assets.
- The full iPhone, Watch and notification-extension Debug simulator build succeeded under Swift 6 with no Swift compiler warnings or errors. Xcode emitted its existing AppIntents metadata-skipped warnings.
- Installed and launched an isolated preview build on paired iPhone 18 Pro Max / Series 12 simulators with a disposable local relay/API configured. The iPhone welcome screen's new masthead was visually checked at its actual layout size. No audio-path code changed; no latency measurement or device/TestFlight verification was performed.
- Product-name accessibility labels match the new artwork. Legacy filenames and Xcode identifiers remain stable. Mascots and app icons contain no product lettering and are unchanged; reference boards and original generation prompts remain historical.
- Captured App Store screenshots that contain the old name need fresh captures after the full app text and display-name rename (tracked in `RENAME_CHECKLIST.md`). No website deployment or App Store upload was performed.

## Original collection — September 27, 2026

- All 41 PNG files decoded successfully; native dimensions, color modes, DPI and SHA-256 hashes are recorded in `manifest.json`.
- Both app icon masters are exactly 1024 × 1024, RGB without alpha, opaque to all four corners.
- All catalog image references exist and have the expected dimensions. Screen images are 256/512/768 px at 1×/2×/3×.
- The iPhone icon catalog compiled with Xcode 27 `actool`, iOS 16 minimum; exit 0 and `Assets.car` produced.
- The Watch icon catalog compiled with Xcode 27 `actool`, watchOS 9 minimum; exit 0 and `Assets.car` produced.
- The screen-art catalog compiled with Xcode 27 `actool`, iOS 16 minimum; exit 0 and `Assets.car` produced.
- Sandbox CoreSimulator connection/log diagnostics were emitted during compilation. No icon/catalog compilation errors were reported. No app build or simulator launch was attempted.
- Merchandise copies retain alpha and carry 300 DPI metadata; no master was enlarged.
- Browser visual inspection checked rounded-square and circular previews, the horizontal wordmark on ivory, full-color transparency on ivory and indigo, and black-ink artwork on white.
- Every preview image link resolves to a delivered file.
- Deliverables are raster artwork. Large-format print, spot-color plate preparation, embroidery digitization and layered Icon Composer documents have not been produced.
