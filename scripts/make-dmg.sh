#!/bin/sh
# Puts Jarvis.app (built by `npm run app`) in a disk image, dist/Jarvis.dmg, with the usual
# drag-to-Applications layout. The app inside still runs this project folder, so it is for this Mac.
set -e
cd "$(dirname "$0")/.."
app="$HOME/Applications/Jarvis.app"
[ -d "$app" ] || { echo "Build the app first: npm run app"; exit 1; }
stage="$(mktemp -d)"
ditto "$app" "$stage/Jarvis.app" # keeps the signature
ln -s /Applications "$stage/Applications"
hdiutil create -volname Jarvis -srcfolder "$stage" -ov -format UDZO dist/Jarvis.dmg >/dev/null
rm -rf "$stage"
echo "Built dist/Jarvis.dmg"
