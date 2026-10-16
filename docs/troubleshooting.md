# Troubleshooting

The device reports problems in its header and in Settings. The importer also writes what it did, line by line, to the Max window: in Live choose **View > Show the Max for Live Window** (Option-Command-M).

## "The components RBox to Live needs are not installed yet"

Open **Settings** and press **Install components**. You need an internet connection once.

If it says Python 3 was not found, install the command line tools by running `xcode-select --install` in Terminal, or install Python from python.org, then try again. The Python needs the `venv` module; the one from Apple's command line tools and from Homebrew has it.

The install log is shown in the Settings panel. The private environment lives in `~/Library/Application Support/RBox to Live/venv`; deleting that folder and installing again is a safe reset.

## "Rekordbox database not found, or its drive is not connected"

- Connect the drive that holds your Rekordbox library, then press **Connect**.
- If the library is somewhere unusual, open **Settings** and set the **Rekordbox database file** to the full path of `master.db`.
- Rekordbox 5 libraries are not supported; the file must be the `master.db` used by Rekordbox 6 or 7.

## "No database key" or "The database key was rejected"

Rekordbox encrypts its library, and RBox to Live does not provide, derive or look up the key: you enter your own in **Settings > Database key** (see "The database key" in the README). The project cannot help you obtain one.

- No key: install the components if you have not, then paste your key into **Settings > Database key** and press **Save and reconnect**.
- Rejected: check the key for a missing character or a trailing space, and that it belongs to the Rekordbox version that wrote this library. **Remove saved key** deletes the one the device holds.
- Never paste the key, or your `master.db`, into an issue or a log you share.

## The device says it is offline after I replaced it

Remove the device from the track and drop it again. A new copy of the device takes over the bridge from the old one. If something else on your Mac uses port 37373, quit it, or restart Live.

## Locators are missing or off the beat

Live puts new locators on the Arrangement grid, which follows the zoom, so the device zooms the Arranger in a step at a time to land each one on its own beat. A locator that still cannot be placed exactly is left out, and the Max window says which one ("no locator appeared at beat ..."). Keep Live in front and leave it alone while it works; clicking in the Arrangement during placement can move the playhead.

Locators cannot be undone with Live's undo. Delete the ones you do not want.

## Beats do not line up

The Max window reports how many beats Live placed warp markers for (for example `39 of 39 beats placed in Live`). If the number is lower, the track's grid in Rekordbox may have gaps; fix the grid in Rekordbox and import again. Beat 0 is always left to Live's start marker.

## A track cannot be imported

- **Streaming track: no local file to import**: the entry has no file on disk.
- **File unavailable: connect its music drive**: the audio file Rekordbox points to is not reachable. Connect the drive or restore the file.

## Live will not load the device, or its scripts

Files downloaded from the internet are quarantined by macOS, which can stop Max from running them. The installer clears this. To do it by hand:

```bash
xattr -dr com.apple.quarantine "$HOME/Music/Ableton/User Library/Presets/Audio Effects/Max Audio Effect/RBox to Live"
```

## The large view does not open

Open `http://127.0.0.1:37373/` in any browser while the device is loaded in Live.

## Start over

Run **Uninstall RBox to Live.command** and answer `y` to remove the settings and private environment, then install again. Your Rekordbox library and music files are not touched by any of this.
