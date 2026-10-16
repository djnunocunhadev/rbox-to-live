#!/bin/zsh
# Installs the RBox to Live Max for Live device into your Ableton User Library.
# Double-click this file, or run it in Terminal. Pass a different folder as the first argument if your User Library
# is not in the default place.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/RBox to Live"
DEST="${1:-$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect}"

if [ ! -d "$SOURCE" ]; then
  echo "Could not find the 'RBox to Live' folder next to this script."
  [ -n "$RBOX_NONINTERACTIVE" ] || read -r "?Press Return to close this window. "
  exit 1
fi

mkdir -p "$DEST"
rm -rf "$DEST/RBox to Live"
ditto "$SOURCE" "$DEST/RBox to Live"
# Files downloaded from the internet are quarantined by macOS, which can stop Max from loading the device's scripts.
xattr -dr com.apple.quarantine "$DEST/RBox to Live" 2>/dev/null || true

echo ""
echo "Installed RBox to Live in:"
echo "  $DEST/RBox to Live"
echo ""
echo "In Ableton Live, open the browser, go to Audio Effects > Max Audio Effect > RBox to Live,"
echo "and drop 'RBox to Live.amxd' on a track. The first time, open Settings in the device and choose"
echo "'Install components' (needs an internet connection once). Then enter your own Rekordbox database key in"
echo "Settings: this project does not provide one."
[ -n "$RBOX_NONINTERACTIVE" ] || open "$DEST/RBox to Live" 2>/dev/null || true
[ -n "$RBOX_NONINTERACTIVE" ] || read -r "?Press Return to close this window. "
