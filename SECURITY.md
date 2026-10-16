# Security

## What the device does, and does not do

- It opens your Rekordbox `master.db` **read-only** (SQLite `mode=ro` and `query_only`). It runs no statement that writes.
- Its bridge listens on `127.0.0.1` only. Every request needs a random token generated each time the device starts, and requests with an unexpected `Host` or `Origin` are refused, so another website open in your browser cannot talk to it.
- It has no telemetry and no update check. The only network use is the one-time download of the SQLCipher driver when you press **Install components**; `requirements.txt` pins that package by SHA-256 hash.
- It does not provide, derive, look up or download a Rekordbox database key. You enter your own in Settings. The key is stored in `~/Library/Application Support/RBox to Live/settings.json` (mode 600), is passed to the reader over a private pipe, is never written to a log and is never sent back to the page.

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- Use **Report a vulnerability** under the repository's **Security** tab (GitHub private vulnerability reporting), or
- if that is not available, open an issue that says only that you have a security report, with no details, and a maintainer will arrange a private channel.

Include the version (see `VERSION`), what you did, and what you expected. This is a free project maintained in spare time, so there is no guaranteed response time, but reports are taken seriously and credited if you wish.

## Never post these

Whatever you report, and wherever you post it (issues, pull requests, logs, screenshots):

- **Do not post your Rekordbox database key**, or anything derived from it.
- Do not post your `master.db`, your `settings.json`, or any other file from your Rekordbox library.
- Do not post the bridge token from a running device.

If you pasted one of these by mistake, delete the comment or issue, and treat the key as exposed.

## Supported versions

Only the latest release receives fixes.
