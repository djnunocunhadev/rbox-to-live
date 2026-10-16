#!/bin/zsh
# For development: builds the device from the sources in this repository and installs it into your Ableton User Library.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/scripts/build-device.py"
DEST="${1:-$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect}"
mkdir -p "$DEST"
rm -rf "$DEST/RBox to Live"
ditto "$ROOT/dist/RBox to Live" "$DEST/RBox to Live"
echo "Installed RBox to Live in: $DEST/RBox to Live"
