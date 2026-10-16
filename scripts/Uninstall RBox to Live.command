#!/bin/zsh
# Removes the RBox to Live device from your Ableton User Library.
# It can also remove the settings and the private Python environment the device created.
set -e
DEST="${1:-$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect}"
SUPPORT="$HOME/Library/Application Support/RBox to Live"

if [ -d "$DEST/RBox to Live" ]; then
  rm -rf "$DEST/RBox to Live"
  echo "Removed $DEST/RBox to Live"
else
  echo "No RBox to Live device found in $DEST"
fi

if [ -d "$SUPPORT" ]; then
  [ -n "$RBOX_NONINTERACTIVE" ] && ANSWER=n || read -r "?Also remove your RBox to Live settings and its private Python environment ($SUPPORT)? [y/N] " ANSWER
  if [ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ]; then
    rm -rf "$SUPPORT"
    echo "Removed $SUPPORT"
  fi
fi
echo "Your Rekordbox library and your music files were never changed."
[ -n "$RBOX_NONINTERACTIVE" ] || read -r "?Press Return to close this window. "
