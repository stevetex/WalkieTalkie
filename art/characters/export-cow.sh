#!/bin/bash
# Export the approved lighter-spotted cow without redrawing the master.
set -euo pipefail
cd "$(dirname "$0")/../.."
character=art/characters/19-cow
swift art/characters/icon-from-master.swift "$character/master.png" \
  "$character/icons/icon-1024.png" 872 68 0
for platform in iPhone Watch; do
  cp "$character/icons/icon-1024.png" \
    "$character/icons/$platform.xcassets/OAOCowIcon.appiconset/icon-1024.png"
done
for size in 48 96 180 256 512; do
  sips -z "$size" "$size" "$character/icons/icon-1024.png" \
    --out "$character/icons/exports/icon-$size.png" >/dev/null
done
for scale in 1 2 3; do
  size=$((256 * scale))
  sips -z "$size" "$size" "$character/master.png" \
    --out "$character/app/CharacterArt.xcassets/OAOCow.imageset/OAOCow@${scale}x.png" >/dev/null
done
sips -s dpiWidth 300 -s dpiHeight 300 "$character/master.png" \
  --out "$character/merch/color-300dpi.png" >/dev/null
sips -z 288 288 "$character/icons/icon-1024.png" \
  --out app/iOS/Assets.xcassets/Mascots/MascotCow.imageset/MascotCow.png >/dev/null
cp "$character/icons/exports/icon-96.png" \
  app/Watch/Assets.xcassets/Mascots/MascotCow.imageset/MascotCow.png
