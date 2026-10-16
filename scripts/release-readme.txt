RBox to Live
============

A Max for Live device that puts your Rekordbox library inside Ableton Live. Search the collection, pick a track,
and import it with its phrases, hot cues, beat grid and vocal positions laid out on the Arrangement.
It only reads: your Rekordbox library and your music files are never changed.

Install
-------
1. Double-click "Install RBox to Live.command". (If macOS objects to a downloaded script, right-click it and choose Open.)
2. In Ableton Live open the browser, go to Audio Effects > Max Audio Effect > RBox to Live,
   and drop "RBox to Live.amxd" on a track.
3. The first time, press Settings in the device, then "Install components". This needs an internet connection once.
   It builds a private Python environment under ~/Library/Application Support/RBox to Live and does not touch your
   system Python. The only thing it downloads is the SQLCipher database driver, pinned by hash.
4. Enter your own Rekordbox database key in Settings. See "The database key" below.

Needs macOS, Ableton Live 12 with Max for Live, Rekordbox 6 or 7, and Python 3 (Apple's command line tools have one:
run "xcode-select --install" if it is missing).

In Settings you can also point the device at a specific Rekordbox database file.

The database key
----------------
Rekordbox encrypts its library. RBox to Live does NOT provide, include, generate, derive or download that key, and
cannot help you find it. You must obtain your own key elsewhere and enter it once in Settings > Database key. It is
stored only on your Mac, in a file only your user can read. Use a key only with a library you own or are entitled to
open, and check your Rekordbox licence terms and the law where you live.

Not affiliated with AlphaTheta, Pioneer DJ, Ableton or Cycling '74. Provided as is, without warranty. It only reads
your library, but back it up anyway. Credits and licences: THIRD_PARTY_NOTICES.md.

Remove it with "Uninstall RBox to Live.command".

More: Troubleshooting.md in this folder, and the project page for screenshots and the full guide.
Licence: MIT (see LICENSE). Security: SECURITY.md.
