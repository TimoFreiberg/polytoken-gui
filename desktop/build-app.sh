#!/usr/bin/env bash
# build-app.sh — compile the Swift shell with swiftc and assemble Pilot.app.
#
# Uses swiftc directly (no SwiftPM/Xcode): the app has no third-party deps — just
# AppKit/WebKit from the system SDK — so a plain compile is all it needs, and it works
# with only the Command Line Tools installed. We assemble the .app bundle by hand
# (Info.plist + binary under Contents/), so there's no Xcode project to maintain.
#
# Ad-hoc signed (personal/local use): not notarized, so the first launch needs a
# right-click → Open to get past Gatekeeper.
set -euo pipefail
cd "$(dirname "$0")"

APP="Pilot.app"
ARCH="$(uname -m)"                       # arm64 (Apple Silicon) or x86_64
TARGET="${ARCH}-apple-macos13.0"         # pin min OS so we don't inherit the SDK's

echo "→ compiling (swiftc, $TARGET)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$TARGET" \
    -framework AppKit -framework WebKit \
    Sources/Pilot/*.swift \
    -o "$APP/Contents/MacOS/Pilot"

cp Info.plist "$APP/Contents/Info.plist"

# App icon. Generate the .icns from icon-1024.png (the full-bleed pilot mark, rendered
# from ../client/public/icon.svg) using only system tools — sips + iconutil ship with
# macOS, so this keeps the "builds with just the Command Line Tools" promise.
echo "→ generating app icon (sips + iconutil)"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size"             icon-1024.png --out "$ICONSET/icon_${size}x${size}.png"    >/dev/null
    sips -z $((size*2)) $((size*2))     icon-1024.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET")"

# Stamp the desktop/ tree sha into the bundle so the running app knows which version of the
# native shell it was built from. The update-watcher compares this (via PILOT_APP_DESKTOP_SHA)
# against origin/main:desktop to decide whether a pulled update needs a native rebuild +
# relaunch (vs just a server restart). Tree sha, not git HEAD, so a TS-only commit doesn't
# trip it. Done BEFORE codesign so the stamp is sealed inside the signature. git-unreachable
# (e.g. a non-git build) → skip rather than stamp junk; auto-update just won't rebuild the app.
if DESKTOP_SHA="$(git rev-parse HEAD:desktop 2>/dev/null)" && [ -n "$DESKTOP_SHA" ]; then
    printf '%s' "$DESKTOP_SHA" > "$APP/Contents/Resources/.pilot-desktop-sha"
    echo "→ stamped desktop sha ${DESKTOP_SHA:0:7}"
else
    echo "→ git unavailable; skipped desktop-sha stamp (auto-update won't rebuild the app)"
fi

# Ad-hoc signature ("-" identity). Enough for a local app; swap for a Developer ID +
# notarization if you ever want frictionless double-click installs across machines.
if codesign --force --sign - "$APP" 2>/dev/null; then
    echo "→ ad-hoc signed"
else
    echo "→ codesign unavailable; skipped (right-click → Open will still work)"
fi

echo
echo "Built $PWD/$APP"
echo "Run:  open \"$PWD/$APP\"     (or move it to /Applications)"
