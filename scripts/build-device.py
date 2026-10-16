#!/usr/bin/env python3
"""Build the Max for Live device folder, and optionally a release zip, from the readable sources.

    python3 scripts/build-device.py          builds dist/RBox to Live/
    python3 scripts/build-device.py --zip    also builds dist/RBox-to-Live-<version>.zip
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
OUT = DIST / "RBox to Live"
DEVICE_FILES = (
    "rbox-to-live-node.js",
    "rbox-to-live-db.py",
    "rbox-to-live-live.js",
    "rbox-to-live.html",
)


def chunk(tag: bytes, payload: bytes) -> bytes:
    return tag + struct.pack("<I", len(payload)) + payload


def build_device() -> Path:
    patcher = json.loads((ROOT / "src" / "rbox-to-live.maxpat.json").read_text(encoding="utf-8"))
    patcher_bytes = json.dumps(patcher, ensure_ascii=False, indent="\t").encode("utf-8")

    # Start from an empty folder so nothing from an earlier build is left in it.
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for name in DEVICE_FILES:
        shutil.copy2(ROOT / "src" / name, OUT / name)
    shutil.copy2(ROOT / "requirements.txt", OUT / "requirements.txt")
    shutil.copy2(ROOT / "LICENSE", OUT / "LICENSE.txt")
    shutil.copy2(ROOT / "THIRD_PARTY_NOTICES.md", OUT / "THIRD_PARTY_NOTICES.md")
    shutil.copy2(ROOT / "VERSION", OUT / "VERSION.txt")
    (OUT / "RBox to Live.maxpat").write_bytes(patcher_bytes)

    # The AMXD layout used by Live's bundled Max devices: an AMPF marker chunk, version metadata, and a PTCH chunk with
    # the patcher JSON. The outer type marker must agree with patcher.project.amxdtype.
    # `natt` marks a MIDI Tool; `aaaa` marks a Max Audio Effect.
    amxd = chunk(b"ampf", b"aaaa") + chunk(b"meta", struct.pack("<I", 0)) + chunk(b"ptch", patcher_bytes)
    (OUT / "RBox to Live.amxd").write_bytes(amxd)
    print(f"Built {OUT / 'RBox to Live.amxd'}")
    return OUT


def build_zip() -> Path:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    target = DIST / f"RBox-to-Live-{version}.zip"
    extras = [
        (ROOT / "scripts" / "Install RBox to Live.command", "Install RBox to Live.command"),
        (ROOT / "scripts" / "Uninstall RBox to Live.command", "Uninstall RBox to Live.command"),
        (ROOT / "scripts" / "release-readme.txt", "README.txt"),
        (ROOT / "docs" / "troubleshooting.md", "Troubleshooting.md"),
        (ROOT / "LICENSE", "LICENSE"),
        (ROOT / "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
        (ROOT / "SECURITY.md", "SECURITY.md"),
    ]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(OUT.rglob("*")):
            if path.is_file():
                archive.write(path, Path("RBox-to-Live") / "RBox to Live" / path.relative_to(OUT))
        for path, name in extras:
            info = zipfile.ZipInfo(str(Path("RBox-to-Live") / name), date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path.suffix == ".command" else 0o644) << 16
            archive.writestr(info, path.read_bytes())
    print(f"Built {target}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zip", action="store_true", help="also build the release zip")
    args = parser.parse_args()
    build_device()
    if args.zip:
        build_zip()


if __name__ == "__main__":
    main()
