"""Repository hygiene: no database key, no key-finding code, no private library files, and the safety documents exist.

These checks are a safety net for contributors and for the maintainer. They cannot prove a key is absent, but they catch
the usual mistakes: pasting a key, adding code that finds one, committing a library or music file, or dropping a document.
"""
import os
import re
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {".git", "node_modules", "dist", ".claude", "__pycache__"}
SELF = {os.path.join("tests", "test_repo_hygiene.py"), os.path.join("tests", "test_reader.py")}
PRIVATE_SUFFIXES = (".db", ".sqlite", ".sqlite3", ".dat", ".ext", ".2ex", ".mp3", ".wav", ".flac", ".aif", ".aiff", ".m4a",
                    ".alc", ".als", ".asd", ".pdb")
KEY_FINDING_CODE = ("pyrekordbox", "deobfuscate", "XOR_MASK", "BLOB", "rekordbox_key", "dp_key", "get_key")


def tracked_files():
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
        names = [n for n in out.decode("utf-8").split("\0") if n]
        if names:
            return [n for n in names if os.path.exists(os.path.join(ROOT, n))]
    except (OSError, subprocess.CalledProcessError):
        pass
    names = []
    for folder, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        names += [os.path.relpath(os.path.join(folder, f), ROOT) for f in files]
    return names


def text_of(name):
    path = os.path.join(ROOT, name)
    with open(path, "rb") as handle:
        data = handle.read()
    if b"\0" in data:
        return None
    return data.decode("utf-8", errors="replace")


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as handle:
        return handle.read()


class RepoHygiene(unittest.TestCase):
    def test_no_private_library_or_media_files_are_tracked(self):
        bad = [n for n in tracked_files() if n.lower().endswith(PRIVATE_SUFFIXES) or os.path.basename(n) in ("settings.json", "instance.json")]
        self.assertEqual(bad, [], "library, media or settings files must not be committed")

    def test_no_long_key_like_strings_are_committed(self):
        # 32+ characters of letters, digits and + / = that include at least two digits: the shape of a key or a token.
        # The SHA-256 pins in requirements.txt are the one allowed exception.
        shape = re.compile(r"[A-Za-z0-9+/=]{32,}")
        found = []
        for name in tracked_files():
            text = text_of(name)
            if text is None:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if name == "requirements.txt" and "--hash=sha256:" in line:
                    continue
                for token in shape.findall(line):
                    if sum(ch.isdigit() for ch in token) >= 2 and any(ch.isalpha() for ch in token):
                        found.append(f"{name}:{number}")
        self.assertEqual(found, [], "a long key-like string was committed; the database key must never be in the repository")

    def test_no_key_literal_is_passed_to_sqlcipher(self):
        text = read(os.path.join("src", "rbox-to-live-db.py"))
        self.assertIsNone(re.search(r"PRAGMA\s+key\s*=\s*['\"]\s*[^'\"\s+]", text, re.I), "the key must come from the user, never a literal")
        self.assertIsNone(re.search(r"\.encode\(\s*['\"][A-Za-z0-9+/=]{16,}['\"]", text), "no key literal")

    def test_no_key_finding_code_is_present(self):
        found = []
        for name in tracked_files():
            if name in SELF or not name.startswith(("src" + os.sep, "scripts" + os.sep, "tests" + os.sep)):
                continue
            text = text_of(name)
            if text is None:
                continue
            text = text.replace("the pyrekordbox documentation", "")
            for needle in KEY_FINDING_CODE:
                if needle in text:
                    found.append(f"{name}: {needle}")
        self.assertEqual(found, [], "code that finds or derives a Rekordbox key must not be added")

    def test_the_only_component_is_the_hash_pinned_sqlcipher_driver(self):
        lines = [l.strip() for l in read("requirements.txt").splitlines()]
        lines = [l for l in lines if l and not l.startswith("#")]
        joined = " ".join(l.rstrip("\\").strip() for l in lines)
        parts = joined.split("--hash=")
        self.assertEqual(parts[0].strip(), "sqlcipher3-wheels==0.5.7", "requirements.txt may hold only the pinned driver")
        self.assertGreaterEqual(len(parts) - 1, 1)
        for part in parts[1:]:
            self.assertRegex(part.strip(), r"^sha256:[0-9a-f]{64}$")

    def test_the_safety_and_acknowledgement_documents_exist(self):
        for name in ("LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "THIRD_PARTY_NOTICES.md",
                     os.path.join(".github", "PULL_REQUEST_TEMPLATE.md")):
            self.assertTrue(os.path.exists(os.path.join(ROOT, name)), name)
        self.assertTrue(os.listdir(os.path.join(ROOT, ".github", "ISSUE_TEMPLATE")))

    def test_the_readme_says_the_key_is_not_provided(self):
        readme = read("README.md").lower()
        for phrase in ("does **not** provide", "your own rekordbox database key", "not made, endorsed or supported by", "no warranty",
                       "third_party_notices.md"):
            self.assertIn(phrase, readme, phrase)

    def test_every_component_is_credited(self):
        notices = read("THIRD_PARTY_NOTICES.md").lower()
        for name in ("sqlcipher3-wheels", "sqlcipher", "openssl", "deep symmetry", "pyrekordbox", "ableton", "cycling '74"):
            self.assertIn(name, notices, name)

    def test_the_templates_warn_against_posting_keys(self):
        for name in ("bug_report.yml", "feature_request.yml"):
            self.assertIn("database key", read(os.path.join(".github", "ISSUE_TEMPLATE", name)).lower(), name)
        self.assertIn("database key", read(os.path.join(".github", "PULL_REQUEST_TEMPLATE.md")).lower())

    def test_the_reader_cannot_supply_a_key_on_its_own(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("rbox_db_hygiene", os.path.join(ROOT, "src", "rbox-to-live-db.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        saved = os.environ.pop("RBOX_DB_KEY", None)
        try:
            with self.assertRaises(module.ReaderError) as caught:
                module.resolve_key("")
            self.assertEqual(caught.exception.code, "key-missing")
        finally:
            if saved is not None:
                os.environ["RBOX_DB_KEY"] = saved


if __name__ == "__main__":
    unittest.main()
