#!/bin/sh
# Redraws the app icon (scripts/make-icon.swift) and packs it as assets/Jarvis.icns, in every size macOS wants.
set -e
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
set="$work/Jarvis.iconset"
mkdir -p "$set" assets
swift scripts/make-icon.swift "$work/icon.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$work/icon.png" --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$work/icon.png" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o assets/Jarvis.icns
rm -rf "$work"
echo "Built assets/Jarvis.icns"
