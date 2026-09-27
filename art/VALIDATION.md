# Asset validation — September 27, 2026

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
