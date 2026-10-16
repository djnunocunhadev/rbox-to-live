# Development

## Layout

| Path | What it is |
| --- | --- |
| `src/rbox-to-live.maxpat.json` | The Max patcher, as readable JSON. |
| `src/rbox-to-live-node.js` | The `node.script` bridge: HTTP server, settings, token, components installer, reader process. |
| `src/rbox-to-live-db.py` | The Rekordbox reader (SQLCipher, read-only) and the analysis-file parsers. |
| `src/rbox-to-live-live.js` | The importer that runs in Max and drives Live's Object Model. |
| `src/rbox-to-live.html` | The interface. |
| `scripts/build-device.py` | Builds the `.amxd` and, with `--zip`, the release archive. |
| `scripts/dev-install.command` | Builds and installs into your Ableton User Library. |
| `scripts/Install RBox to Live.command`, `scripts/Uninstall RBox to Live.command` | The scripts shipped in the release zip. |
| `tests/` | Node and Python tests. |
| `requirements.txt` | The one Python package the device installs for itself (the SQLCipher driver), pinned by SHA-256 hash for macOS. |

## Build and install

```bash
python3 scripts/build-device.py          # dist/RBox to Live/
python3 scripts/build-device.py --zip    # also dist/RBox-to-Live-<version>.zip
./scripts/dev-install.command            # build, then copy into the Ableton User Library
```

The `.amxd` is assembled by hand from the patcher JSON (an `ampf` marker, a `meta` chunk and the `ptch` patcher), so building needs only Python 3, not Max. After installing a new build, remove the device from the Live track and drop it again so Live loads the new files.

The version number lives in `VERSION`.

## Tests

```bash
./scripts/test.sh
```

- `tests/importer.test.js` runs `rbox-to-live-live.js` against `tests/helpers/mock-live.js`, an in-memory stand-in for Live's Object Model. It reproduces the Live 12.3 behaviours the importer works around: locators snapping to a zoom-dependent grid, a playhead that cannot pass the song length, and a refused warp marker at beat 0. It also checks that nothing the user already has is deleted or renamed.
- `tests/bridge.test.js` starts the real bridge with a stub `max-api` and a fake reader. It covers the token, the Host and Origin checks, the settings (including that the key is saved with mode 600 and never echoed), and a newer bridge taking over the port.
- `tests/test_reader.py` runs the reader against a SQLite stand-in and synthetic analysis files: key and path handling, phrase names and colours, the beat grid, vocals, and the read-only guarantees.

Needs Node 18 or newer and Python 3.9 or newer. Neither Live nor Rekordbox is needed.

## Trying it against Live

Build and install, load the device in a Live set you do not mind changing, and watch the Max window (Option-Command-M). Use Live's Undo for tracks and clips; locators have to be removed by hand.

For screenshots or experiments without your own library, point **Settings > Rekordbox database file** at a copy of a library you do not mind showing.

## Notes on the bridge

The bridge listens on `127.0.0.1:37373` only. A random token is generated at start and written into the page it serves; `instance.json` in the support folder (mode 600) lets a newer copy of the device ask an older one to give up the port. Environment variables `RBOX_READER`, `RBOX_PORT`, `RBOX_PYTHON`, `RBOX_SUPPORT_DIR` and `RBOX_NO_OPEN` exist for the tests and are not used otherwise.
