#!/bin/zsh
# Runs the Node and Python test suites. Neither Ableton Live nor Rekordbox is needed.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "== Node tests =="
node --test tests/*.test.js
echo ""
echo "== Python tests =="
python3 -m unittest discover -s tests -p 'test_*.py' -v
