#!/usr/bin/env python3
"""A stand-in for the Rekordbox reader that speaks the same JSON-lines protocol, for the bridge tests.

The key "good-key" is accepted; any other key is rejected; no key at all reports key-missing.
"""
import json
import sys

config = json.loads(sys.stdin.readline() or "{}")
key = config.get("key") or ""
if not key:
    print(json.dumps({"event": "fatal", "code": "key-missing", "message": "No database key."}), flush=True)
elif key != "good-key":
    print(json.dumps({"event": "fatal", "code": "key-rejected", "message": "Key rejected."}), flush=True)
else:
    print(json.dumps({"event": "ready", "tracks": 3, "dbPath": config.get("dbPath") or "/fake/master.db"}), flush=True)
    for line in sys.stdin:
        payload = json.loads(line)
        print(json.dumps({"event": "response", "requestId": payload.get("requestId"), "action": payload.get("action"),
                          "data": {"total": 0, "items": []}}), flush=True)
