"""Tests for src/rbox-to-live-db.py that need no Rekordbox library, no SQLCipher and no network."""
import importlib.util
import io
import json
import os
import sqlite3
import struct
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "src" / "rbox-to-live-db.py"
spec = importlib.util.spec_from_file_location("rbox_db", SOURCE)
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


def entry(kind, k1=0, k2=0, k3=0):
    return types.SimpleNamespace(kind=kind, k1=k1, k2=k2, k3=k3)


class PhraseNames(unittest.TestCase):
    def test_mid_mood_names_have_no_repeat_numbers(self):
        names = [db.phrase_label(2, entry(kind))[0] for kind in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)]
        self.assertEqual(names, ["Intro", "Verse 1", "Verse 2", "Verse 3", "Verse 4", "Verse 5", "Verse 6", "Bridge", "Chorus", "Outro"])

    def test_low_mood_groups_the_verse_kinds(self):
        names = [db.phrase_label(3, entry(kind))[0] for kind in (2, 3, 4, 5, 6, 7)]
        self.assertEqual(names, ["Verse 1"] * 3 + ["Verse 2"] * 3)

    def test_high_mood_variants_follow_the_flags(self):
        label = lambda *a, **k: db.phrase_label(1, entry(*a, **k))[0]
        self.assertEqual(label(1, k1=1), "Intro 1")
        self.assertEqual(label(1, k1=0), "Intro 2")
        self.assertEqual(label(2), "Up 1")
        self.assertEqual(label(2, k3=1), "Up 2")
        self.assertEqual(label(2, k2=1), "Up 3")
        self.assertEqual(label(3), "Down")
        self.assertEqual(label(5, k1=1), "Chorus 1")
        self.assertEqual(label(5, k1=0), "Chorus 2")
        self.assertEqual(label(6, k1=1), "Outro 1")
        self.assertEqual(label(6, k1=0), "Outro 2")

    def test_unknown_kinds_keep_their_number_and_get_a_neutral_colour(self):
        self.assertEqual(db.phrase_label(1, entry(4)), ("Kind 4", db.UNNAMED_COLOR))
        self.assertEqual(db.phrase_label(2, entry(99)), ("Kind 99", db.UNNAMED_COLOR))

    def test_every_named_phrase_has_a_colour(self):
        for kind in range(1, 11):
            self.assertNotEqual(db.phrase_label(2, entry(kind))[1], db.UNNAMED_COLOR, kind)
        for kind, flags in [(1, {"k1": 1}), (1, {}), (2, {}), (2, {"k3": 1}), (2, {"k2": 1}), (3, {}), (5, {"k1": 1}), (5, {}), (6, {"k1": 1}), (6, {})]:
            self.assertNotEqual(db.phrase_label(1, entry(kind, **flags))[1], db.UNNAMED_COLOR, (kind, flags))

    def test_hot_cue_slots_have_colours(self):
        self.assertEqual(sorted(db.HOT_CUE_COLORS), list("ABCDEFGH"))
        self.assertEqual(sorted(db.HOT_CUES.values()), list("ABCDEFGH"))


class Locations(unittest.TestCase):
    def test_a_configured_database_path_wins(self):
        self.assertEqual(db.library_path("~/x/master.db"), Path("~/x/master.db").expanduser())
        self.assertEqual(db.library_path("  /tmp/m.db  "), Path("/tmp/m.db"))

    def test_without_a_setting_the_path_comes_from_rekordbox_then_the_defaults(self):
        with tempfile.TemporaryDirectory() as home:
            options = Path(home) / "options.json"
            options.write_text(json.dumps({"options": [["db-path", "/Volumes/Music/PIONEER/Master/master.db"]]}))
            with mock.patch.object(db, "OPTIONS", options):
                self.assertEqual(db.library_path(None), Path("/Volumes/Music/PIONEER/Master/master.db"))
            with mock.patch.object(db, "OPTIONS", Path(home) / "missing.json"), mock.patch.object(Path, "home", return_value=Path(home)):
                self.assertEqual(db.library_path(""), Path(home) / "Library/Pioneer/rekordbox/master.db")

    def test_analysis_files_are_found_for_an_external_drive_and_for_the_internal_library(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            # External drive: <drive>/PIONEER/Master/master.db, analysis under <drive>/PIONEER/USBANLZ
            drive = tmp / "Drive"
            (drive / "PIONEER" / "Master").mkdir(parents=True)
            (drive / "PIONEER" / "USBANLZ" / "abc").mkdir(parents=True)
            (drive / "PIONEER" / "USBANLZ" / "abc" / "ANLZ0000.EXT").write_bytes(b"x")
            found = db.analysis_file(drive / "PIONEER" / "Master" / "master.db", "/PIONEER/USBANLZ/abc/ANLZ0000.DAT", ".EXT")
            self.assertEqual(found, drive / "PIONEER" / "USBANLZ" / "abc" / "ANLZ0000.EXT")
            # Internal library: <rekordbox>/master.db, analysis under <rekordbox>/share/PIONEER/USBANLZ
            internal = tmp / "rekordbox"
            (internal / "share" / "PIONEER" / "USBANLZ" / "def").mkdir(parents=True)
            (internal / "share" / "PIONEER" / "USBANLZ" / "def" / "ANLZ0000.DAT").write_bytes(b"x")
            found = db.analysis_file(internal / "master.db", "/PIONEER/USBANLZ/def/ANLZ0000.DAT", ".DAT")
            self.assertEqual(found, internal / "share" / "PIONEER" / "USBANLZ" / "def" / "ANLZ0000.DAT")
            self.assertIsNone(db.analysis_file(internal / "master.db", "/PIONEER/USBANLZ/zzz/ANLZ0000.DAT", ".DAT"))
            self.assertIsNone(db.analysis_file(internal / "master.db", None, ".DAT"))

    def test_no_machine_specific_path_is_baked_in(self):
        text = SOURCE.read_text(encoding="utf-8")
        for needle in ("/Volumes/", "/Users/"):
            self.assertNotIn(needle, text)


class KeyAndDatabaseErrors(unittest.TestCase):
    def test_a_typed_key_is_used_as_given_apart_from_surrounding_whitespace(self):
        self.assertEqual(db.resolve_key("  abc123\n"), "abc123")

    def test_without_a_typed_key_the_reader_refuses_and_says_the_user_has_to_supply_one(self):
        for nothing in (None, "", "   \n"):
            with self.assertRaises(db.ReaderError) as caught:
                db.resolve_key(nothing)
            self.assertEqual(caught.exception.code, "key-missing")
            self.assertIn("device settings", str(caught.exception))
            self.assertIn("does not include one", str(caught.exception))

    def test_the_project_never_derives_looks_up_or_ships_a_database_key(self):
        text = SOURCE.read_text(encoding="utf-8")
        for needle in ("pyrekordbox", "deobfuscate", "BLOB", "XOR_MASK"):
            self.assertNotIn(needle, text.replace("the pyrekordbox documentation", ""), needle)
        self.assertFalse(any(m.startswith("pyrekordbox") for m in sys.modules), "the reader must not import pyrekordbox")

    def test_missing_components_are_reported_as_such(self):
        with mock.patch.dict(sys.modules, {"sqlcipher3": None}):
            with self.assertRaises(db.ReaderError) as caught:
                db.open_library({"dbPath": "/nope", "key": "k"})
        self.assertEqual(caught.exception.code, "deps")

    def test_a_missing_database_is_reported_with_its_path(self):
        fake = types.ModuleType("sqlcipher3")
        with mock.patch.dict(sys.modules, {"sqlcipher3": fake}):
            with self.assertRaises(db.ReaderError) as caught:
                db.open_library({"dbPath": "/definitely/not/here/master.db", "key": "k"})
        self.assertEqual(caught.exception.code, "db-missing")
        self.assertIn("/definitely/not/here/master.db", str(caught.exception))

    def test_a_rejected_key_is_reported_as_such(self):
        class Connection:
            def __init__(self):
                self.row_factory = None
            def execute(self, sql):
                if sql.startswith("SELECT"):
                    raise sqlite3.DatabaseError("file is not a database")
                return self
            def close(self):
                pass
        fake = types.ModuleType("sqlcipher3")
        fake.connect = lambda *a, **k: Connection()
        fake.Row = sqlite3.Row
        with tempfile.NamedTemporaryFile(suffix=".db") as handle, mock.patch.dict(sys.modules, {"sqlcipher3": fake}):
            with self.assertRaises(db.ReaderError) as caught:
                db.open_library({"dbPath": handle.name, "key": "wrong"})
        self.assertEqual(caught.exception.code, "key-rejected")


class Configuration(unittest.TestCase):
    def test_a_configure_line_is_read_and_is_not_treated_as_a_request(self):
        stream = io.StringIO(json.dumps({"action": "configure", "dbPath": "/x", "key": "k"}) + "\n" + json.dumps({"action": "search"}) + "\n")
        with mock.patch.object(db.select, "select", return_value=([stream], [], [])):
            config, first = db.read_configuration(stream)
        self.assertEqual((config["dbPath"], config["key"]), ("/x", "k"))
        self.assertIsNone(first)
        self.assertEqual(json.loads(stream.readline())["action"], "search")

    def test_a_request_without_a_configure_line_is_kept_as_the_first_request(self):
        stream = io.StringIO(json.dumps({"action": "search", "requestId": 1}) + "\n")
        with mock.patch.object(db.select, "select", return_value=([stream], [], [])):
            config, first = db.read_configuration(stream)
        self.assertEqual(config, {})
        self.assertEqual(json.loads(first)["action"], "search")

    def test_nothing_on_stdin_means_the_defaults(self):
        with mock.patch.object(db.select, "select", return_value=([], [], [])):
            self.assertEqual(db.read_configuration(io.StringIO(""), wait_seconds=0), ({}, None))


class AnalysisFiles(unittest.TestCase):
    @staticmethod
    def anlz(*tags):
        body = b"".join(struct.pack(">4sII", fourcc, 12, 12 + len(payload)) + payload for fourcc, payload in tags)
        return b"PMAI" + struct.pack(">I", 28) + b"\x00" * 20 + body

    def test_a_tag_is_found_by_walking_the_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ANLZ0000.EXT"
            path.write_bytes(self.anlz((b"PCOB", b"\x00" * 8), (b"PSSI", b"\x01" * 16)))
            self.assertTrue(db.has_tag(path, b"PSSI"))
            self.assertFalse(db.has_tag(path, b"PVDI"))
            self.assertEqual(db.analysis_tag_body(path, b"PSSI"), b"\x01" * 16)

    def test_damaged_or_foreign_files_are_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            junk = Path(tmp) / "junk"
            junk.write_bytes(b"not an analysis file")
            self.assertFalse(db.has_tag(junk, b"PSSI"))
            self.assertFalse(db.has_tag(Path(tmp) / "missing", b"PSSI"))


class Queries(unittest.TestCase):
    """The SQL, run on a small SQLite stand-in with the tables and columns the reader uses."""

    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        c = self.conn
        c.executescript("""
            create table djmdArtist(ID text, Name text);
            create table djmdAlbum(ID text, Name text);
            create table djmdGenre(ID text, Name text);
            create table djmdKey(ID text, ScaleName text);
            create table djmdContent(ID integer, Title text, ArtistID text, AlbumID text, GenreID text, KeyID text, BPM integer,
                Length integer, FolderPath text, AnalysisDataPath text, rb_local_deleted integer);
            create table djmdCue(ContentID integer, Kind integer, InMsec integer, OutMsec integer, Comment text, rb_local_deleted integer);
            create table djmdPlaylist(ID integer, ParentID integer, Name text, Attribute integer, Seq integer, SmartList text, rb_local_deleted integer);
            create table djmdSongPlaylist(PlaylistID integer, ContentID integer, TrackNo integer, rb_local_deleted integer);
            insert into djmdArtist values ('1', 'Artist One');
            insert into djmdKey values ('1', 'Am');
            insert into djmdContent values (1, 'Alpha', '1', null, null, '1', 12400, 300, '/music/alpha.aif', null, 0);
            insert into djmdContent values (2, 'Beta', '1', null, null, '1', 12200, 200, 'spotify:track:abc', null, 0);
            insert into djmdContent values (3, 'Deleted', '1', null, null, '1', 12000, 100, '/music/deleted.aif', null, 1);
            insert into djmdCue values (1, 1, 1000, null, 'Cue 1', 0);
            insert into djmdCue values (1, 0, 1000, null, 'Memory', 0);
            insert into djmdCue values (1, 3, 60000, null, 'Drop', 0);
            insert into djmdPlaylist values (10, 0, 'Folder', 1, 1, '', 0);
            insert into djmdPlaylist values (11, 10, 'Set', 0, 1, '', 0);
            insert into djmdSongPlaylist values (11, 1, 1, 0);
            insert into djmdSongPlaylist values (11, 2, 2, 0);
        """)

    def test_search_skips_deleted_tracks_and_puts_streaming_entries_last(self):
        result = db.request(self.conn, Path("/x/master.db"), {"action": "search", "query": ""})
        self.assertEqual(result["total"], 2)
        self.assertEqual([t["title"] for t in result["items"]], ["Alpha", "Beta"])
        self.assertEqual([t["streaming"] for t in result["items"]], [False, True])

    def test_search_matches_title_and_artist(self):
        by_title = db.request(self.conn, Path("/x/master.db"), {"action": "search", "query": "alp"})
        self.assertEqual([t["title"] for t in by_title["items"]], ["Alpha"])
        by_artist = db.request(self.conn, Path("/x/master.db"), {"action": "search", "query": "artist one"})
        self.assertEqual(by_artist["total"], 2)

    def test_hot_cues_are_attached_and_memory_cues_are_not(self):
        track = db.request(self.conn, Path("/x/master.db"), {"action": "search", "query": "alp"})["items"][0]
        self.assertEqual([(c["letter"], c["ms"]) for c in track["hotCues"]], [("A", 1000), ("C", 60000)])
        self.assertEqual(track["bpm"], 124.0)
        self.assertEqual(track["key"], "Am")

    def test_tracks_without_analysis_are_flagged_as_having_no_phrases(self):
        for track in db.request(self.conn, Path("/x/master.db"), {"action": "search", "query": ""})["items"]:
            self.assertIs(track["phrases"], False)

    def test_playlists_come_back_as_a_tree_and_a_playlist_lists_its_tracks(self):
        tree = db.request(self.conn, Path("/x/master.db"), {"action": "playlists"})
        flat = json.dumps(tree)
        self.assertIn("Folder", flat)
        self.assertIn("Set", flat)
        tracks = db.request(self.conn, Path("/x/master.db"), {"action": "playlist", "id": 11})
        self.assertEqual(tracks["total"], 2)

    def test_the_reader_never_writes(self):
        text = SOURCE.read_text(encoding="utf-8").lower()
        for statement in ("insert into", "update djmd", "delete from", "drop table", "create table", "alter table"):
            self.assertNotIn(statement, text)
        self.assertIn("query_only=on", text)
        self.assertIn("mode=ro", text)


class AnalysisReaders(unittest.TestCase):
    """Vocals, phrases and the beat grid, read from synthetic analysis files laid out like an external drive."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.drive = Path(self._tmp.name)
        (self.drive / "PIONEER" / "Master").mkdir(parents=True)
        self.folder = self.drive / "PIONEER" / "USBANLZ" / "abc"
        self.folder.mkdir(parents=True)
        self.db_path = self.drive / "PIONEER" / "Master" / "master.db"
        self.analysis = "/PIONEER/USBANLZ/abc/ANLZ0000.DAT"

    @staticmethod
    def tag(fourcc, header_length, payload):
        """One ANLZ tag: four-character code, header length, total length, then the rest of the header and body."""
        return struct.pack(">4sII", fourcc, header_length, header_length + len(payload) - (header_length - 12)) + payload

    @classmethod
    def anlz_file(cls, *tags):
        body = b"".join(tags)
        return b"PMAI" + struct.pack(">I", 28) + struct.pack(">I", 28 + len(body)) + b"\x00" * 16 + body

    @classmethod
    def beat_grid_tag(cls, entries):
        """PQTZ: 12 more header bytes (two unknowns, entry count), then 8-byte entries (beat in bar, bpm x 100, time in ms)."""
        payload = struct.pack(">III", 0, 0x80000, len(entries)) + b"".join(struct.pack(">HHI", b, int(t * 100), ms) for b, t, ms in entries)
        return cls.tag(b"PQTZ", 24, payload)

    @classmethod
    def structure_tag(cls, mood, end_beat, phrases):
        """PSSI: 20 more header bytes, then 24-byte entries. phrases = [(beat, kind, k1, k2, k3)]."""
        head = struct.pack(">IHH", 24, len(phrases), mood) + b"\x00" * 6 + struct.pack(">H", end_beat) + b"\x00\x00\x00\x00"
        entries = b""
        for i, (beat, kind, k1, k2, k3) in enumerate(phrases):
            entries += struct.pack(">HHHBBBBBBHHHBBBBH", i + 1, beat, kind, 0, k1, 0, k2, 0, 0, 0, 0, 0, 0, k3, 0, 0, 0)
        return cls.tag(b"PSSI", 32, head + entries)

    def test_vocal_frames_become_regions_with_short_gaps_merged_and_short_blips_dropped(self):
        frame = db.VOCAL_FRAME_SECONDS
        per_second = round(1 / frame)
        # About 10 s of vocals, a 0.5 s gap (merged), about 5 s of vocals, 20 s of silence, a 0.2 s blip (dropped).
        body = bytes([200]) * (10 * per_second) + bytes(per_second // 2) + bytes([200]) * (5 * per_second)
        body += bytes(20 * per_second) + bytes([200]) * (per_second // 5)
        header = struct.pack(">4sII", b"PVDI", 12, 12 + len(body))
        file_bytes = b"PMAI" + struct.pack(">I", 28) + b"\x00" * 20 + header + body
        (self.folder / "ANLZ0000.2EX").write_bytes(file_bytes)

        regions = db.vocal_regions(self.db_path, self.analysis, bpm=120.0, first_beat_ms=0.0, length_ms=600000)
        self.assertEqual(len(regions), 1)
        self.assertAlmostEqual(regions[0]["startMs"], 0, delta=5)
        merged_frames = 10 * per_second + per_second // 2 + 5 * per_second
        self.assertAlmostEqual(regions[0]["endMs"], merged_frames * frame * 1000, delta=2)
        self.assertAlmostEqual(regions[0]["endBeat"], merged_frames * frame * 2, delta=0.01)

    def test_no_vocal_data_means_no_regions(self):
        self.assertEqual(db.vocal_regions(self.db_path, self.analysis, 120.0, 0.0, 1000), [])
        self.assertEqual(db.vocal_regions(self.db_path, None, 120.0, 0.0, 1000), [])

    def test_phrases_become_named_coloured_sections_on_the_beat_grid(self):
        tag = self.structure_tag(2, 97, [(1, 1, 0, 0, 0), (33, 2, 0, 0, 0), (65, 9, 0, 0, 0)])
        (self.folder / "ANLZ0000.EXT").write_bytes(self.anlz_file(tag))
        sections = db.structure_sections(self.db_path, self.analysis, bpm=120.0, first_beat_ms=500.0, length_ms=300000)
        self.assertEqual([s["name"] for s in sections], ["Intro", "Verse 1", "Chorus"])
        self.assertEqual([(s["startBeat"], s["endBeat"]) for s in sections], [(0.0, 32.0), (32.0, 64.0), (64.0, 96.0)])
        self.assertEqual(sections[0]["startMs"], 0, "the first phrase starts at the top of the file")
        self.assertEqual(sections[1]["startMs"], 16500, "beat 33 is 32 beats after the first beat at 500 ms (120 BPM)")
        self.assertTrue(all(isinstance(s["color"], int) for s in sections))

    def test_the_high_mood_flags_pick_the_numbered_variants(self):
        tag = self.structure_tag(1, 129, [(1, 1, 1, 0, 0), (33, 2, 0, 0, 1), (65, 5, 1, 0, 0), (97, 6, 0, 0, 0)])
        (self.folder / "ANLZ0000.EXT").write_bytes(self.anlz_file(tag))
        sections = db.structure_sections(self.db_path, self.analysis, bpm=120.0, first_beat_ms=0.0, length_ms=300000)
        self.assertEqual([s["name"] for s in sections], ["Intro 1", "Up 2", "Chorus 1", "Outro 2"])

    def test_a_track_without_phrase_analysis_has_no_sections(self):
        self.assertIsNone(db.structure_sections(self.db_path, self.analysis, 120.0, 0.0, 1000))
        (self.folder / "ANLZ0000.EXT").write_bytes(self.anlz_file(self.beat_grid_tag([(1, 120, 0)])))
        self.assertIsNone(db.structure_sections(self.db_path, self.analysis, 120.0, 0.0, 1000))

    def test_phrase_analysis_in_the_obfuscated_export_form_is_not_read(self):
        plain = self.structure_tag(2, 97, [(1, 1, 0, 0, 0), (33, 2, 0, 0, 0)])
        scrambled = bytearray(plain)
        scrambled[18:20] = b"\xc3\x91"  # a mood value outside 1..3: the tag is not in the plain layout
        ext = self.folder / "ANLZ0000.EXT"
        ext.write_bytes(self.anlz_file(bytes(scrambled)))
        self.assertIsNone(db.structure_sections(self.db_path, self.analysis, 120.0, 0.0, 1000))
        self.assertFalse(db.has_plain_song_structure(ext), "such a track is not badged as having phrases")
        ext.write_bytes(self.anlz_file(plain))
        self.assertTrue(db.has_plain_song_structure(ext))

    def test_the_beat_grid_is_returned_in_ms_without_repeats_or_beats_past_the_end(self):
        grid = [(1, 120, 250), (2, 120, 750), (3, 120, 750), (4, 120, 1250), (1, 120, 1200), (2, 120, 1750), (3, 120, 90000)]
        (self.folder / "ANLZ0000.DAT").write_bytes(self.anlz_file(self.beat_grid_tag(grid)))
        beats = db.beat_times_ms(self.db_path, self.analysis, length_ms=5000)
        self.assertEqual(beats, [250.0, 750.0, 1250.0, 1750.0])

    def test_the_first_beat_and_tempo_come_from_the_beat_grid(self):
        (self.folder / "ANLZ0000.DAT").write_bytes(self.anlz_file(self.beat_grid_tag([(1, 124.0, 24), (2, 124.0, 508)])))
        row = {"BPM": 12000, "AnalysisDataPath": self.analysis}
        bpm, first = db.resolve_grid_info(self.db_path, row, [])
        self.assertEqual((bpm, first), (124.0, 24.0))

    def test_damaged_analysis_files_give_nothing_instead_of_an_error(self):
        for name in ("ANLZ0000.DAT", "ANLZ0000.EXT"):
            (self.folder / name).write_bytes(b"PMAI" + b"\x00" * 5)
        self.assertEqual(db.beat_times_ms(self.db_path, self.analysis, 5000), [])
        self.assertIsNone(db.structure_sections(self.db_path, self.analysis, 120.0, 0.0, 1000))

    def test_a_missing_beat_grid_file_gives_an_empty_grid(self):
        self.assertEqual(db.beat_times_ms(self.db_path, self.analysis, 5000), [])


if __name__ == "__main__":
    unittest.main()
