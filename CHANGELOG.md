# Changelog

## 1.0.0

First public version.

- Browse and search a Rekordbox 6/7 library from a Max for Live device in Ableton Live 12, with a Large view in a browser window.
- Import a track as phrase clips (Song Structure), hot-cue clips, or one clip, named and coloured by phrase or cue slot.
- Locators on the Arrangement at each hot cue, placed on the exact beat; vocal regions on a Vocal Position track; warp markers on every beat of the Rekordbox grid; tempo and key set from the track.
- Importing never deletes or replaces anything already in the Live set.
- Settings for the database file and the database key. The key is always supplied by the user: the project does not provide, derive or download one.
- Own parsers for Rekordbox's analysis files (beat grid, song structure, vocal positions), so the only installed component is the SQLCipher driver, pinned by SHA-256 hash.
- Self-contained install: a release zip with an installer, and a private Python environment built from the device (no change to your system Python).
- Read-only access to the library, a localhost-only bridge with a per-run token, and a key that is never shipped.
- Project documents: third-party notices, security policy, contributing guide, code of conduct, issue and pull request templates, and a test that guards against committed keys and key-finding code.
