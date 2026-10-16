#!/usr/bin/env python3
"""Read the local Rekordbox 6/7 SQLCipher library and emit JSON lines.

The connection uses SQLite URI mode=ro and PRAGMA query_only=ON. This tool has no SQL write statements and makes no
network connections.

The Rekordbox database is encrypted. The key is never included with this project and is never derived, looked up or
downloaded by it: the user supplies their own (device settings, or RBOX_DB_KEY when running the reader by hand).

The bridge starts it with a JSON "configure" line on stdin (database path and key; the path is optional) and then sends
requests as JSON lines. Without a configure line, the RBOX_DB_PATH and RBOX_DB_KEY environment variables are used,
which is handy when running the reader by hand.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import select
import struct
import sys
import types
import unicodedata
from urllib.parse import unquote, urlparse


HOT_CUES = {1: "A", 2: "B", 3: "C", 5: "D", 6: "E", 7: "F", 8: "G", 9: "H"}

# Phrase names and colours. The phrase kinds by mood (PSSI header: High=1, Mid=2, Low=3) follow the published analysis-file
# notes (Deep Symmetry, "DJ Link Ecosystem Analysis", chapter "Analysis Files"; the pyrekordbox documentation). Sections are named by their
# phrase alone, with no repeat numbers. In the High mood the entry's k1/k2/k3 flags pick a numbered variant. The chorus rule
# (k1=1 is "Chorus 1", k1=0 is "Chorus 2") is the reverse of one published note and matches the labels seen on real tracks.
# The colours are our own values, chosen by eye.
MID_NAMES = {1: "Intro", 2: "Verse 1", 3: "Verse 2", 4: "Verse 3", 5: "Verse 4", 6: "Verse 5", 7: "Verse 6",
             8: "Bridge", 9: "Chorus", 10: "Outro"}
LOW_NAMES = {1: "Intro", 2: "Verse 1", 3: "Verse 1", 4: "Verse 1", 5: "Verse 2", 6: "Verse 2", 7: "Verse 2",
             8: "Bridge", 9: "Chorus", 10: "Outro"}
# Clip colours (0xRRGGBB), one per phrase. Verses run along one blue-to-purple ramp.
MID_COLORS = {"Intro": 0xD4554F, "Verse 1": 0x526EF6, "Verse 2": 0x5255F8, "Verse 3": 0x6254F7, "Verse 4": 0x7251F6,
              "Verse 5": 0x8653F6, "Verse 6": 0x9652F3, "Bridge": 0xDFD65D, "Chorus": 0x89C182, "Outro": 0x758197}
HIGH_COLORS = {"Intro 1": 0xD4554F, "Intro 2": 0xBB401E, "Up 1": 0x8036F5, "Up 2": 0x6A35F4, "Up 3": 0x5433F4,
               "Down": 0x7E35F6, "Chorus 1": 0x4BA82D, "Chorus 2": 0x4AA97F, "Outro 1": 0x5D84BF, "Outro 2": 0x5F88A8}
UNNAMED_COLOR = 0x9E9E9E
# The colour of the vocal-position clips.
VOCAL_COLOR = 0x4695D0
# The clips of a Hot Cues split are named by the cue letter and coloured by slot.
HOT_CUE_COLORS = {"A": 0xE9476C, "B": 0x63ACD9, "C": 0x89BF50, "D": 0xA374F6, "E": 0x68CE78, "F": 0xD26B31,
                  "G": 0x3B59F7, "H": 0xC2AF39}


def phrase_label(mood, entry):
    """The section name for one PSSI entry, and its colour."""
    kind = int(entry.kind)
    if mood == 1:
        k1, k2, k3 = int(entry.k1), int(entry.k2), int(entry.k3)
        if kind == 1:
            name = "Intro 1" if k1 else "Intro 2"
        elif kind == 2:
            name = "Up 3" if k2 else ("Up 2" if k3 else "Up 1")
        elif kind == 3:
            name = "Down"
        elif kind == 5:
            name = "Chorus 1" if k1 else "Chorus 2"
        elif kind == 6:
            name = "Outro 1" if k1 else "Outro 2"
        else:
            return f"Kind {kind}", UNNAMED_COLOR
        return name, HIGH_COLORS.get(name, UNNAMED_COLOR)
    names = LOW_NAMES if mood == 3 else MID_NAMES
    name = names.get(kind)
    if name is None:
        return f"Kind {kind}", UNNAMED_COLOR
    return name, MID_COLORS.get(name, UNNAMED_COLOR)


# The open master.db, set by main(). The track list checks each track's phrase analysis next to it.
DB_PATH = None
phrase_analysis_cache = {}
OPTIONS = Path.home() / "Library/Application Support/Pioneer/rekordboxAgent/storage/options.json"


class ReaderError(Exception):
    """A failure the device can explain to the user. The code says which settings panel helps."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def resolve_existing_path(path_str: str | None) -> str | None:
    if not path_str:
        return None
    raw = str(path_str).strip()
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        raw = unquote(parsed.path)
    if os.path.isfile(raw):
        return raw
    nfc = unicodedata.normalize("NFC", raw)
    if os.path.isfile(nfc):
        return nfc
    nfd = unicodedata.normalize("NFD", raw)
    if os.path.isfile(nfd):
        return nfd
    return None


def library_path(configured: str | None = None) -> Path:
    """The master.db to open: the path set in the device settings, else the one Rekordbox reports, else the defaults."""
    if configured and str(configured).strip():
        return Path(str(configured).strip()).expanduser()
    try:
        data = json.loads(OPTIONS.read_text(encoding="utf-8"))
        for key, value in data.get("options", []):
            if key == "db-path" and value:
                return Path(value).expanduser()
    except (OSError, ValueError, TypeError):
        pass
    candidates = (
        Path.home() / "Library/Pioneer/rekordbox/master.db",
        Path.home() / "Documents/Pioneer/rekordbox/master.db",
    )
    return next((path for path in candidates if path.is_file()), candidates[0])


def resolve_key(manual: str | None) -> str:
    """The SQLCipher key, as supplied by the user. There is no fallback: this project does not provide, derive or fetch it."""
    if manual and str(manual).strip():
        return str(manual).strip()
    raise ReaderError(
        "key-missing",
        "No database key. Enter your own in the device settings; this project does not include one.",
    )


def open_library(config: dict | None = None):
    config = config or {}
    try:
        import sqlcipher3
    except ImportError as error:
        raise ReaderError(
            "deps",
            "The components RBox to Live needs are not installed yet. Open the settings and choose Install components.",
        ) from error

    db_path = library_path(config.get("dbPath") or os.environ.get("RBOX_DB_PATH"))
    if not db_path.is_file():
        raise ReaderError("db-missing", f"Rekordbox database not found, or its drive is not connected: {db_path}")
    key = resolve_key(config.get("key") or os.environ.get("RBOX_DB_KEY"))

    uri = db_path.resolve().as_uri() + "?mode=ro"
    conn = sqlcipher3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlcipher3.Row
    conn.execute("PRAGMA cipher='sqlcipher'")
    conn.execute("PRAGMA legacy=4")
    conn.execute("PRAGMA key='" + key.replace("'", "''") + "'")
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except Exception as error:
        conn.close()
        if "not a database" in str(error).lower():
            raise ReaderError("key-rejected", "Rekordbox did not accept this database key. Check the key in the device settings.") from error
        raise
    return conn, db_path


def analysis_roots(db_path: Path) -> list[Path]:
    """Folders a track's analysis path (such as /PIONEER/USBANLZ/...) can be relative to.

    A library on an external drive keeps master.db in <drive>/PIONEER/Master and the analysis files in
    <drive>/PIONEER/USBANLZ, so the drive root is one of the candidates. The internal library keeps them under share.
    """
    roots = [db_path.parent / "share", db_path.parent]
    roots += list(db_path.parents[:3])
    roots += [
        Path.home() / "Library/Pioneer/rekordbox/share",
        Path.home() / "Library/Application Support/Pioneer/rekordbox/share",
    ]
    seen, unique = set(), []
    for root in roots:
        if root not in seen:
            seen.add(root)
            unique.append(root)
    return unique


def analysis_file(db_path, analysis_path, suffix):
    """The Rekordbox analysis file next to a track's ANLZ path (".DAT" beat grid, ".EXT" phrases), or None."""
    if not analysis_path:
        return None
    base = str(analysis_path).lstrip("/").rsplit(".", 1)[0]
    for root in analysis_roots(db_path):
        candidate = root / (base + suffix)
        if candidate.is_file():
            return candidate
    return None


def has_tag(path, fourcc):
    """Whether an ANLZ file holds a tag, found by walking the tag headers so the file body is not read."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(12)
            if head[:4] != b"PMAI":
                return False
            size = os.fstat(handle.fileno()).st_size
            position = struct.unpack(">I", head[4:8])[0]
            while position + 12 <= size:
                handle.seek(position)
                header = handle.read(12)
                if len(header) < 12:
                    break
                if header[:4] == fourcc:
                    return True
                tag_length = struct.unpack(">I", header[8:12])[0]
                if tag_length < 12:
                    break
                position += tag_length
    except (OSError, struct.error):
        return False
    return False


def has_plain_song_structure(path):
    """Whether an ANLZ file holds a PSSI tag in the plain layout (reads only the headers, not the whole file)."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(12)
            if head[:4] != b"PMAI":
                return False
            size = os.fstat(handle.fileno()).st_size
            position = struct.unpack(">I", head[4:8])[0]
            while position + 12 <= size:
                handle.seek(position)
                header = handle.read(32)
                if len(header) < 12:
                    break
                tag_length = struct.unpack(">I", header[8:12])[0]
                if header[:4] == b"PSSI":
                    return len(header) >= 20 and PSSI_MOODS[0] <= struct.unpack(">H", header[18:20])[0] <= PSSI_MOODS[1]
                if tag_length < 12:
                    break
                position += tag_length
    except (OSError, struct.error):
        return False
    return False


def anlz_tag(path, fourcc):
    """(header length, whole tag bytes) of the first tag with this four-character code in an ANLZ file, or None."""
    data = Path(path).read_bytes()
    if data[:4] != b"PMAI":
        return None
    position = struct.unpack(">I", data[4:8])[0]
    while position + 12 <= len(data):
        header_length, tag_length = struct.unpack(">II", data[position + 4:position + 12])
        if tag_length < 12:
            break
        if data[position:position + 4] == fourcc:
            return header_length, data[position:position + tag_length]
        position += tag_length
    return None


def beat_grid(path):
    """The beat grid (PQTZ tag, .DAT file) as [(beat in bar, bpm, time in ms)] in file order; empty when absent or unreadable."""
    found = anlz_tag(path, b"PQTZ")
    if not found or found[0] != 24 or len(found[1]) < 24:
        return []
    tag = found[1]
    count = struct.unpack(">I", tag[20:24])[0]
    body = tag[24:24 + count * 8]
    return [(beat, tempo / 100.0, ms) for beat, tempo, ms in struct.iter_unpack(">HHI", body[:len(body) // 8 * 8])]


# Rekordbox's own mood codes in a song-structure tag: High 1, Mid 2, Low 3.
PSSI_MOODS = (1, 3)


def song_structure(path):
    """Phrase analysis (PSSI tag, .EXT file) as (mood, end beat, [phrase]), or None when absent or not in the plain layout.

    Rekordbox also writes this tag in an obfuscated form (when it exports to a USB drive). This project does not undo that
    obfuscation: such a track simply has no phrase analysis here.
    """
    found = anlz_tag(path, b"PSSI")
    if not found:
        return None
    header_length, tag = found
    if header_length < 32 or len(tag) < 32:
        return None
    entry_bytes = struct.unpack(">I", tag[12:16])[0]
    count, mood = struct.unpack(">HH", tag[16:20])
    if entry_bytes != 24 or not PSSI_MOODS[0] <= mood <= PSSI_MOODS[1]:
        return None
    end_beat = struct.unpack(">H", tag[26:28])[0]
    phrases = []
    for i in range(count):
        o = header_length + i * 24
        if o + 24 > len(tag):
            break
        index, beat, kind = struct.unpack(">HHH", tag[o:o + 6])
        phrases.append(types.SimpleNamespace(index=index, beat=beat, kind=kind, k1=tag[o + 7], k2=tag[o + 9], k3=tag[o + 19]))
    return mood, end_beat, phrases


def has_phrase_analysis(analysis_path):
    """Whether the track has phrase analysis this reader can use: a PSSI tag in its .EXT file, in the plain layout."""
    if DB_PATH is None or not analysis_path:
        return False
    ext = analysis_file(DB_PATH, analysis_path, ".EXT")
    if ext is None:
        return False
    key = str(ext)
    if key not in phrase_analysis_cache:
        phrase_analysis_cache[key] = has_plain_song_structure(ext)
    return phrase_analysis_cache[key]


def track_rows(conn, where_sql="", args=(), limit=100, offset=0):
    joins = """
      from djmdContent c
      left join djmdArtist a on a.ID = c.ArtistID
      left join djmdAlbum al on al.ID = c.AlbumID
      left join djmdGenre g on g.ID = c.GenreID
      left join djmdKey k on k.ID = c.KeyID
    """
    filter_sql = "where c.rb_local_deleted = 0" + (f" and ({where_sql})" if where_sql else "")
    total = conn.execute(f"select count(*) {joins} {filter_sql}", args).fetchone()[0]
    rows = conn.execute(
        f"""select c.ID as id, c.Title as title, coalesce(a.Name, '') as artist,
                   al.Name as album, g.Name as genre,
                   case when c.BPM > 0 then c.BPM / 100.0 else null end as bpm,
                   k.ScaleName as key, c.Length as lengthSec,
                   c.FolderPath as filePath, c.AnalysisDataPath as analysisPath
              {joins} {filter_sql}
             order by (c.FolderPath like 'spotify:%'), c.Title collate nocase, c.ID
             limit ? offset ?""",
        (*args, limit, offset),
    ).fetchall()
    return {"total": total, "items": attach_cues(conn, rows)}


def attach_cues(conn, rows):
    items = []
    if not rows:
        return items
    ids = [int(row["id"]) for row in rows]
    marks = ",".join("?" for _ in ids)
    cue_rows = conn.execute(
        f"""select ContentID, Kind, InMsec, OutMsec, Comment from djmdCue
             where rb_local_deleted = 0 and ContentID in ({marks})
               and (Kind = 0 or Kind in (1,2,3,5,6,7,8,9))
             order by InMsec, Kind""",
        ids,
    ).fetchall()
    cues_by_id = {}
    for cue in cue_rows:
        cues_by_id.setdefault(int(cue["ContentID"]), []).append({
            "kind": int(cue["Kind"]),
            "letter": HOT_CUES.get(int(cue["Kind"]), "Memory"),
            "ms": int(cue["InMsec"] or 0),
            "outMs": int(cue["OutMsec"]) if cue["OutMsec"] else None,
            "comment": cue["Comment"] or "",
        })
    for row in rows:
        value = dict(row)
        file_path = value.pop("filePath")
        # Tracks with phrase analysis are marked in the list, so the user can tell them from the rest.
        value["phrases"] = has_phrase_analysis(value.pop("analysisPath", None))
        resolved = resolve_existing_path(file_path)
        value["local"] = bool(resolved or (file_path and str(file_path).startswith("/")))
        # Streaming entries have no file on disk and show with blank tags, so label them.
        value["streaming"] = bool(file_path and str(file_path).startswith("spotify:"))
        value["title"] = value["title"] or ("Streaming track" if value["streaming"] else "Untitled")
        value["artist"] = value["artist"] or ""
        value["hotCues"] = [cue for cue in cues_by_id.get(int(value["id"]), []) if cue["kind"] != 0]
        items.append(value)
    return items


def playlist_tree(conn):
    rows = conn.execute(
        """select ID as id, ParentID as parentId, Name as name, Attribute as attribute,
                  Seq as seq, coalesce(SmartList, '') as smartList
             from djmdPlaylist where rb_local_deleted = 0 order by ParentID, Seq, Name"""
    ).fetchall()
    counts = {
        row[0]: row[1]
        for row in conn.execute(
            "select PlaylistID, count(*) from djmdSongPlaylist where rb_local_deleted = 0 group by PlaylistID"
        )
    }
    result = []
    for row in rows:
        attribute = int(row["attribute"] or 0)
        try:
            parent_id = int(row["parentId"])
        except (TypeError, ValueError):
            parent_id = None
        result.append({
            "id": int(row["id"]),
            "parentId": parent_id if parent_id else None,
            "name": row["name"] or "",
            "kind": "folder" if attribute == 1 else "smart" if attribute == 4 or row["smartList"] else "playlist",
            "count": int(counts.get(row["id"], 0)),
        })
    return result


def playlist_tracks(conn, playlist_id):
    rows = conn.execute(
        """select c.ID as id, c.Title as title, coalesce(a.Name, '') as artist,
                  al.Name as album, g.Name as genre,
                  case when c.BPM > 0 then c.BPM / 100.0 else null end as bpm,
                  k.ScaleName as key, c.Length as lengthSec, c.FolderPath as filePath,
                  c.AnalysisDataPath as analysisPath
             from djmdSongPlaylist sp
             join djmdContent c on c.ID = sp.ContentID
             left join djmdArtist a on a.ID = c.ArtistID
             left join djmdAlbum al on al.ID = c.AlbumID
             left join djmdGenre g on g.ID = c.GenreID
             left join djmdKey k on k.ID = c.KeyID
            where sp.PlaylistID = ? and sp.rb_local_deleted = 0 and c.rb_local_deleted = 0
            order by sp.TrackNo""",
        (playlist_id,),
    ).fetchall()
    items = attach_cues(conn, rows)
    return {"id": int(playlist_id), "total": len(items), "items": items}


def resolve_grid_info(db_path, row, cues):
    bpm = (row["BPM"] or 0) / 100.0 if row else 120.0
    first_beat_ms = 0.0
    anlz_rel = (row["AnalysisDataPath"] or "").lstrip("/") if row else ""
    if anlz_rel:
        anlz_path = analysis_file(db_path, anlz_rel, "." + anlz_rel.rsplit(".", 1)[-1])
        if anlz_path:
            try:
                grid = beat_grid(anlz_path)
                if grid:
                    first_beat_ms = round(float(grid[0][2]), 2)
                    if grid[0][1] > 0:
                        bpm = round(grid[0][1], 2)
            except Exception:
                pass

    if first_beat_ms <= 0.0:
        for c in cues:
            if c.get("ms", 0) > 0:
                first_beat_ms = float(c["ms"])
                break

    return bpm, first_beat_ms


def structure_sections(db_path, analysis_path, bpm, first_beat_ms, length_ms):
    """Phrase sections from the song-structure (PSSI) tag in the track's EXT analysis file, or None."""
    if not analysis_path or not bpm:
        return None
    ext = analysis_file(db_path, analysis_path, ".EXT")
    if ext is None:
        return None
    try:
        structure = song_structure(ext)
        if structure is None:
            return None
        mood, end_beat_number, phrases = structure
    except Exception as error:
        print(f"RBox to Live: phrase analysis unreadable: {error}", file=sys.stderr, flush=True)
        return None
    if not phrases:
        return None
    beat_ms = 60000.0 / bpm

    def ms_at(beat_number):
        # Beat numbers in the analysis are 1-based: beat 1 is the first downbeat.
        return first_beat_ms + (beat_number - 1) * beat_ms

    sections = []
    for i, phrase in enumerate(phrases):
        start_beat = int(phrase.beat)
        end_beat = int(phrases[i + 1].beat) if i + 1 < len(phrases) else end_beat_number
        start_ms = 0.0 if i == 0 else min(max(0.0, ms_at(start_beat)), length_ms)
        end_ms = min(max(start_ms + 100, ms_at(end_beat)), length_ms)
        name, color = phrase_label(mood, phrase)
        sections.append({
            "name": name,
            "kind": int(phrase.kind),
            "color": color,
            "letter": f"P{i + 1}",
            "startMs": int(start_ms),
            "endMs": int(end_ms),
            "startBeat": 0.0 if i == 0 else round(start_beat - 1, 3),
            "endBeat": round(max(end_beat - 1, 0), 3),
        })
    return sections


# Rekordbox's vocal detection (PVDI tag in the 2EX analysis file) holds one vocal-confidence byte per frame.
# The frame is 2048 samples at 44.1 kHz; that matches the 21.6 values per second measured on two tracks.
VOCAL_FRAME_SECONDS = 2048 / 44100.0


def analysis_tag_body(path, fourcc):
    """Body bytes of the first tag with this four-character code in an ANLZ file, or None."""
    data = path.read_bytes()
    if data[:4] != b"PMAI":
        return None
    off = struct.unpack(">I", data[4:8])[0]
    while off + 12 <= len(data):
        tag = data[off:off + 4]
        header_len, total_len = struct.unpack(">II", data[off + 4:off + 12])
        if total_len == 0:
            break
        if tag == fourcc:
            return data[off + header_len:off + total_len]
        off += total_len
    return None


def vocal_regions(db_path, analysis_path, bpm, first_beat_ms, length_ms):
    """Vocal sections from Rekordbox's vocal detection, merged across gaps under one second."""
    if not analysis_path or not bpm:
        return []
    body = None
    candidate = analysis_file(db_path, analysis_path, ".2EX")
    if candidate is not None:
        try:
            body = analysis_tag_body(candidate, b"PVDI")
        except (OSError, struct.error):
            body = None
    if not body:
        return []

    frame_ms = VOCAL_FRAME_SECONDS * 1000.0
    runs = []
    start = None
    for i, value in enumerate(body):
        if value and start is None:
            start = i
        elif not value and start is not None:
            runs.append([start, i])
            start = None
    if start is not None:
        runs.append([start, len(body)])

    merged = []
    for s, e in runs:
        if merged and (s - merged[-1][1]) * frame_ms < 1000.0:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    beat_ms = 60000.0 / bpm
    regions = []
    for s, e in merged:
        start_ms = s * frame_ms
        end_ms = min(e * frame_ms, length_ms)
        if end_ms - start_ms < 1000.0:
            continue
        regions.append({
            "startMs": int(start_ms),
            "endMs": int(end_ms),
            "startBeat": round(max(0.0, (start_ms - first_beat_ms) / beat_ms), 3),
            "endBeat": round(max(0.0, (end_ms - first_beat_ms) / beat_ms), 3),
        })
    return regions


def beat_times_ms(db_path, analysis_path, length_ms):
    """Every beat time in the track's beat grid (PQTZ tag of the DAT analysis file), in ms, for warp markers."""
    if not analysis_path:
        return []
    candidate = analysis_file(db_path, analysis_path, ".DAT")
    if candidate is None:
        print(f"RBox to Live: no beat grid file for {analysis_path}", file=sys.stderr, flush=True)
        return []
    try:
        times = [ms / 1000.0 for _, _, ms in beat_grid(candidate)]
    except Exception as error:
        print(f"RBox to Live: beat grid unreadable: {error}", file=sys.stderr, flush=True)
        return []
    out = []
    for t in times:
        ms = round(float(t) * 1000.0, 3)
        if out and ms <= out[-1]:
            continue
        if ms > length_ms + 1000:
            break
        out.append(ms)
    return out


def track_detail(conn, db_path, track_id, split="cues"):
    result = track_rows(conn, "c.ID = ?", (track_id,), limit=1, offset=0)
    if not result["items"]:
        raise RuntimeError("This track is no longer in the Rekordbox collection.")
    track = result["items"][0]
    row = conn.execute(
        "select FolderPath, AnalysisDataPath, Length, BPM from djmdContent where ID = ? and rb_local_deleted = 0", (track_id,)
    ).fetchone()
    file_path = row[0] if row else None
    resolved = resolve_existing_path(file_path)
    track["filePath"] = resolved
    track["fileAvailable"] = bool(resolved)
    cues = conn.execute(
        """select Kind, InMsec, OutMsec, Comment from djmdCue
            where ContentID = ? and rb_local_deleted = 0 and (Kind = 0 or Kind in (1,2,3,5,6,7,8,9))
            order by InMsec, Kind""",
        (track_id,),
    ).fetchall()
    track["cues"] = [
        {"kind": int(cue["Kind"]), "letter": HOT_CUES.get(int(cue["Kind"]), "Memory"),
         "ms": int(cue["InMsec"] or 0), "outMs": int(cue["OutMsec"]) if cue["OutMsec"] else None,
         "comment": cue["Comment"] or ""}
        for cue in cues
    ]

    bpm, first_beat_ms = resolve_grid_info(db_path, row, track["cues"])
    track["bpm"] = bpm
    track["firstBeatMs"] = first_beat_ms

    for c in track["cues"]:
        c["beat"] = max(0.0, round((c["ms"] - first_beat_ms) * bpm / 60000.0, 3))

    length_ms = max(1000, int((track.get("lengthSec") or 180) * 1000))
    hot_cues = [c for c in track["cues"] if c.get("kind") != 0]
    if not hot_cues:
        hot_cues = [c for c in track["cues"] if c.get("ms", 0) >= 0]
    # Rekordbox stores a hot cue more than once on some tracks; one section per cue.
    seen = set()
    unique = []
    for c in hot_cues:
        key = (c["ms"], c["letter"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    hot_cues = unique

    sections = []
    if hot_cues:
        first_cue_ms = hot_cues[0]["ms"]
        beat_interval_ms = (60000.0 / bpm) if bpm > 0 else 500.0
        if first_cue_ms > (beat_interval_ms * 2):
            sections.append({
                "name": "Start",
                "letter": "Start",
                "startMs": 0,
                "endMs": first_cue_ms,
                "startBeat": 0.0,
                "endBeat": max(0.1, round((first_cue_ms - first_beat_ms) * bpm / 60000.0, 3)),
            })
        for i, c in enumerate(hot_cues):
            start_ms = c["ms"]
            end_ms = hot_cues[i + 1]["ms"] if (i + 1 < len(hot_cues)) else length_ms
            start_beat = c["beat"]
            end_beat = hot_cues[i + 1]["beat"] if (i + 1 < len(hot_cues)) else round((length_ms - first_beat_ms) * bpm / 60000.0, 3)
            if c["letter"] in HOT_CUE_COLORS:
                name = c["letter"]
            else:
                name = f"[{c['letter']}] {c['comment'] or ('Cue ' + str(i + 1))}"
            sections.append({
                "name": name,
                "color": HOT_CUE_COLORS.get(c["letter"], UNNAMED_COLOR),
                "letter": c["letter"],
                "startMs": start_ms,
                "endMs": max(start_ms + 100, end_ms),
                "startBeat": start_beat,
                "endBeat": max(start_beat + 0.25, end_beat),
            })
    else:
        sections.append({
            "name": track.get("title") or "Track",
            "letter": "A",
            "startMs": 0,
            "endMs": length_ms,
            "startBeat": 0.0,
            "endBeat": max(1.0, round((length_ms - first_beat_ms) * bpm / 60000.0, 3)),
        })
    structure = structure_sections(db_path, row[1] if row else None, bpm, first_beat_ms, length_ms)
    track["structureAvailable"] = structure is not None
    track["vocalRegions"] = vocal_regions(db_path, row[1] if row else None, bpm, first_beat_ms, length_ms)
    track["beatTimesMs"] = beat_times_ms(db_path, row[1] if row else None, length_ms)
    if split == "none":
        sections = [{
            "name": track.get("title") or "Track",
            "letter": "A",
            "startMs": 0,
            "endMs": length_ms,
            "startBeat": 0.0,
            "endBeat": max(1.0, round((length_ms - first_beat_ms) * bpm / 60000.0, 3)),
        }]
        track["sectionSource"] = "none"
    elif split == "structure" and structure:
        sections = structure
        track["sectionSource"] = "structure"
    else:
        track["sectionSource"] = "cues"
    track["sections"] = sections
    return track


def request(conn, db_path, payload):
    action = payload.get("action")
    if action == "search":
        query = str(payload.get("query") or "").strip().casefold()
        limit = min(max(int(payload.get("limit") or 100), 1), 500)
        offset = max(int(payload.get("offset") or 0), 0)
        if query:
            needle = query
            return track_rows(
                conn,
                "instr(lower(coalesce(c.Title,'')), ?) > 0 or instr(lower(coalesce(a.Name,'')), ?) > 0 "
                "or instr(lower(coalesce(al.Name,'')), ?) > 0 or instr(lower(coalesce(g.Name,'')), ?) > 0",
                (needle, needle, needle, needle), limit, offset,
            )
        return track_rows(conn, limit=limit, offset=offset)
    if action == "playlists":
        return playlist_tree(conn)
    if action == "playlist":
        return playlist_tracks(conn, int(payload["id"]))
    if action == "detail":
        return track_detail(conn, db_path, int(payload["id"]), payload.get("split") or "cues")
    raise RuntimeError("Unknown direct-library request.")


def read_configuration(lines, wait_seconds=1.0):
    """The first stdin line may be {"action": "configure", "dbPath": ..., "key": ...}. Returns it and the first request.

    The bridge sends the line as soon as it starts the reader. When nothing arrives within a second (the reader run by
    hand), the defaults apply.
    """
    try:
        ready, _, _ = select.select([lines], [], [], wait_seconds)
    except (OSError, ValueError):
        ready = [lines]
    if not ready:
        return {}, None
    first = lines.readline()
    if not first.strip():
        return {}, None
    try:
        payload = json.loads(first)
    except ValueError:
        return {}, first
    if isinstance(payload, dict) and payload.get("action") == "configure":
        return payload, None
    return {}, first


def main():
    global DB_PATH
    config, first_request = read_configuration(sys.stdin)
    try:
        conn, db_path = open_library(config)
        DB_PATH = db_path
        count = int(conn.execute("select count(*) from djmdContent where rb_local_deleted = 0").fetchone()[0])
        print(json.dumps({"event": "ready", "tracks": count, "dbPath": str(db_path)}), flush=True)
    except ReaderError as error:
        print(json.dumps({"event": "fatal", "code": error.code, "message": str(error)}), flush=True)
        return
    except Exception as error:
        print(json.dumps({"event": "fatal", "code": "other", "message": str(error)}), flush=True)
        return

    def lines_from_input():
        if first_request is not None:
            yield first_request
        for line in sys.stdin:
            yield line

    for line in lines_from_input():
        if not line.strip():
            continue
        payload = {}
        try:
            payload = json.loads(line)
            response = request(conn, db_path, payload)
            print(json.dumps({"event": "response", "requestId": payload.get("requestId"), "action": payload.get("action"), "data": response}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"event": "error", "requestId": payload.get("requestId"), "message": str(error)}), flush=True)
    conn.close()


if __name__ == "__main__":
    main()
