# Contributing

Thanks for helping. RBox to Live is a free, open-source project maintained in spare time, so small, focused changes are easiest to review.

## Rules that keep the project safe

These are not negotiable, and a pull request that breaks them will be closed:

1. **No database keys.** Do not add a Rekordbox database key, a fragment of one, or an encoded or obfuscated form of one, anywhere: code, tests, docs, screenshots, commit history. The key is always supplied by the user in the device settings.
2. **No key-finding code.** Do not add code that finds, derives, extracts, guesses, de-obfuscates or downloads a Rekordbox key, and do not add dependencies that do. Do not add instructions for doing so in issues, docs or comments either.
3. **No real library data.** Do not commit a real `master.db`, analysis (`.DAT`, `.EXT`) files, music, or screenshots showing someone's library. Tests use a stand-in database and synthetic analysis data; build more of those.
4. **Read-only.** The reader must never write to a Rekordbox library. Anything that writes to Rekordbox is out of scope.
5. **Stay on localhost.** The bridge listens on `127.0.0.1` only and keeps its token and Host/Origin checks. No telemetry, no outside requests other than the pinned component install.
6. **Own work, licensed compatibly.** Only submit code you wrote or have the right to submit under the MIT License. Say where any third-party material comes from and add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not copy code from Rekordbox or from other tools whose licence does not allow it.
7. **No trademarks as branding.** Do not present the project as made or endorsed by AlphaTheta, Pioneer DJ, Ableton or Cycling '74.

`tests/test_repo_hygiene.py` checks the first two rules automatically.

## Working on the code

```bash
./scripts/test.sh
```

runs the Node and Python tests. They need neither Ableton Live nor Rekordbox. [docs/development.md](docs/development.md) explains the layout, building the device and installing it for development.

- Match the style of the file you are editing.
- Add or update a test for any change in behaviour. Parsers take bytes, so a test can build a small synthetic file.
- Update the README and [CHANGELOG.md](CHANGELOG.md) when behaviour changes.
- If you add a dependency, pin it by hash in `requirements.txt`, say why, and update the notices. The aim is to have as few as possible.

## Pull requests

Describe what changed and why, and how you tested it. By submitting a pull request you agree that your contribution is licensed under the [MIT License](LICENSE).

## Issues

Use the templates. Include your Live and Rekordbox versions and the text of the message in the Max window or the device. **Never paste a database key, your `master.db` or your `settings.json`.** Requests for help obtaining a key will be closed.

Be kind: see the [Code of Conduct](CODE_OF_CONDUCT.md).
