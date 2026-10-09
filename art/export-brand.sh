#!/bin/bash
# Refresh every export of the two name-bearing masters. Legacy filenames and
# Xcode asset names are retained so existing consumers continue to resolve.
set -euo pipefail
cd "$(dirname "$0")/.."

stacked="art/masters/brand-stacked-indigo.png"
horizontal="art/masters/lockup-horizontal-dark.png"

square() {
  sips -z "$2" "$2" "$stacked" --out "$1" >/dev/null
}

square art/screens/about-welcome-1024.png 1024
for scale in 1 2 3; do
  size=$((256 * scale))
  name="OverAndOutBrand@${scale}x.png"
  square "art/screens/ScreenArt.xcassets/OverAndOutBrand.imageset/$name" "$size"
  for target in iOS Watch; do
    cp "art/screens/ScreenArt.xcassets/OverAndOutBrand.imageset/$name" \
      "app/$target/Assets.xcassets/OverAndOutBrand.imageset/$name"
  done
done

for width in 600 1200 1800; do
  sips -z "$((width / 3))" "$width" "$horizontal" \
    --out "art/documentation/over-and-out-horizontal-$width.png" >/dev/null
done
sips -s dpiWidth 300 -s dpiHeight 300 "$horizontal" \
  --out art/merch/lockup-horizontal-dark-300dpi.png >/dev/null

for size in 512 768; do
  sips -z "$size" "$size" -s format jpeg -s formatOptions 85 "$stacked" \
    --out "web/public/img/brand-$size.jpg" >/dev/null
done
