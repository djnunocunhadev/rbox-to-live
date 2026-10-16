# Third-party notices

RBox to Live is licensed under the [MIT License](LICENSE). It uses, or was informed by, the work below. Nothing listed here is copied into this repository or into the release zip unless the entry says so.

## Installed on your Mac when you press "Install components"

The device downloads this package from PyPI into its own private Python environment (`~/Library/Application Support/RBox to Live/venv`). `requirements.txt` pins the exact version and the SHA-256 hash of every macOS file, and pip refuses anything that differs. It has no Python dependencies of its own.

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| sqlcipher3-wheels (Python driver) | 0.5.7 | zlib/libpng | <https://github.com/laggykiller/sqlcipher3> |

The wheel is a build of [sqlcipher3](https://github.com/coleifer/sqlcipher3) by Charles Leifer, which descends from [pysqlite](https://github.com/ghaering/pysqlite) by Gerhard Häring. It contains these libraries, built into it:

| Library | Licence | Source |
| --- | --- | --- |
| SQLCipher, by Zetetic, LLC | BSD-style (see the SQLCipher licence) | <https://github.com/sqlcipher/sqlcipher> |
| SQLite | Public domain | <https://sqlite.org/> |
| OpenSSL 3.x | Apache License 2.0 | <https://www.openssl.org/> |

Licence of the Python driver, as shipped in the wheel (`sqlcipher3_wheels-0.5.7.dist-info/licenses/LICENSE`):

```
Copyright (c) 2004-2007 Gerhard Häring

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use
of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it freely,
subject to the following restrictions:

    1. The origin of this software must not be misrepresented; you must not
       claim that you wrote the original software. If you use this software in
       a product, an acknowledgment in the product documentation would be
       appreciated but is not required.

    2. Altered source versions must be plainly marked as such, and must not be
       misrepresented as being the original software.

    3. This notice may not be removed or altered from any source distribution.
```

The SQLCipher and OpenSSL licence texts are in their own repositories linked above. This project does not redistribute them; they reach your Mac from PyPI.

## Software the device runs on

These are used as installed on your Mac and are not part of this repository.

| Software | By | Used for |
| --- | --- | --- |
| Max for Live and Max | Ableton AG and Cycling '74 | Hosting the device (`amxd`), `jweb`, `node.script`, and the JavaScript importer |
| Live Object Model | Ableton AG | Creating tracks, clips, warp markers and locators in Live |
| Node.js (inside Max) | OpenJS Foundation and contributors | Running the bridge between the page and Live |
| Python 3 | Python Software Foundation | Building the private environment and running the reader |

## Format knowledge

The reader has its own parsers for Rekordbox's analysis files (beat grid, song structure, vocal positions). They were written from public documentation, and checked against pyrekordbox's output on a private library; no code from either is used here.

- Deep Symmetry, "DJ Link Ecosystem Analysis", chapter "Analysis Files": <https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html>
- pyrekordbox documentation and source, by Dylan Jones (MIT): <https://github.com/dylanljones/pyrekordbox>

## Trademarks

Rekordbox and Pioneer DJ are trademarks of AlphaTheta Corporation. Ableton, Live and Max for Live are trademarks of Ableton AG. Max is a trademark of Cycling '74. SQLCipher is a trademark of Zetetic, LLC. All other names belong to their owners. This project is independent and is not made, endorsed or supported by any of them.

## Not included

- No Rekordbox database key, and no code that finds, derives or extracts one.
- No Rekordbox, AlphaTheta or Pioneer DJ software, libraries or data.
- No music, samples or artwork other than the README screenshots, which show made-up demo data and one waveform of a track from the author's own collection.

## Fonts and images

The interface uses the system font stack and loads nothing from the internet. The screenshots in `docs/images` were made by the author.

To report a missing or wrong attribution, open an issue.
