#!/usr/bin/env python3
"""Local stand-in for the Apps Script backend so the whole flow can be
demoed/tested offline: serves the static site and implements the same
/exec API (submit, list, setStatus). Responses land in responses.json,
images in uploads/. Run: python3 mock_server.py  → http://localhost:8765
Passcode for admin.html = contents of token.txt (fallback: partypass)."""

import base64
import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "responses.json")
UPLOADS = os.path.join(ROOT, "uploads")
PORT = 8765
LOCK = threading.Lock()

try:
    with open(os.path.join(ROOT, "token.txt")) as fh:
        TOKEN = fh.read().strip()
except OSError:
    TOKEN = "partypass"

STATUSES = {"PENDING", "ACCEPTED", "WAITLIST", "REJECTED"}
REQUIRED = ["name", "socials", "age", "why", "working", "contrarian", "want"]


def load_rows():
    try:
        with open(DATA) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return []


def save_rows(rows):
    with open(DATA, "w") as fh:
        json.dump(rows, fh, indent=2)


def save_images(arr, n, tag, cap):
    os.makedirs(UPLOADS, exist_ok=True)
    urls = []
    for i, f in enumerate(arr[:cap]):
        b64 = str(f.get("data", ""))
        if "," in b64:
            b64 = b64.split(",")[-1]
        if not b64:
            continue
        name = f"{n:03d}-{tag}-{i + 1}.jpg"
        with open(os.path.join(UPLOADS, name), "wb") as fh:
            fh.write(base64.b64decode(b64))
        urls.append(f"/uploads/{name}")
    return urls


class Handler(SimpleHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Dev server: never let the browser cache anything (a heuristically
        # cached config.js once pointed a local test run at the live backend).
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/config.js":
            # Serve a local override so pages served here NEVER post to the
            # live Apps Script backend (config.js in the repo points at prod).
            body = b'window.PARTY_CONFIG = { ENDPOINT: "/exec" };\n'
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path != "/exec":
            return super().do_GET()
        q = parse_qs(u.query)
        if q.get("action", [""])[0] == "list":
            if q.get("token", [""])[0] != TOKEN:
                return self._json({"ok": False, "error": "bad token"})
            return self._json({"ok": True, "rows": load_rows()})
        return self._json({"ok": True, "service": "reids-party-mock"})

    def do_POST(self):
        if urlparse(self.path).path != "/exec":
            return self._json({"ok": False, "error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            p = json.loads(self.rfile.read(length))
        except (ValueError, TypeError):
            return self._json({"ok": False, "error": "bad request"})

        if p.get("action") == "check":
            # mirror the worker's fail-open contract; no real lookups locally
            return self._json({"ok": True, "result": "unknown"})
        if p.get("action") == "setStatus":
            return self._set_status(p)
        if p.get("action") == "delete":
            return self._delete(p)
        if p.get("action") == "list":
            if p.get("token") != TOKEN:
                return self._json({"ok": False, "error": "bad token"})
            return self._json({"ok": True, "rows": load_rows()})
        return self._submit(p)

    def _delete(self, p):
        if p.get("token") != TOKEN:
            return self._json({"ok": False, "error": "bad token"})
        with LOCK:
            rows = load_rows()
            kept = [r for r in rows if str(r.get("n")) != str(p.get("n"))]
            if len(kept) == len(rows):
                return self._json({"ok": False, "error": "applicant not found"})
            save_rows(kept)
            return self._json({"ok": True})

    def _set_status(self, p):
        if p.get("token") != TOKEN:
            return self._json({"ok": False, "error": "bad token"})
        if p.get("status") not in STATUSES:
            return self._json({"ok": False, "error": "bad status"})
        with LOCK:
            rows = load_rows()
            for r in rows:
                if str(r.get("n")) == str(p.get("n")):
                    r["status"] = p["status"]
                    save_rows(rows)
                    return self._json({"ok": True})
        return self._json({"ok": False, "error": "applicant not found"})

    def _submit(self, p):
        if p.get("hp"):
            return self._json({"ok": True, "n": 0})
        a = p.get("answers") or {}
        for k in REQUIRED:
            if not str(a.get(k, "")).strip():
                return self._json({"ok": False, "error": f"Missing required field: {k}"})
        if not str(a.get("email", "")).strip() and not str(a.get("phone", "")).strip():
            return self._json({"ok": False, "error": "Missing contact info."})
        try:
            age = int(str(a.get("age", "")).strip())
        except ValueError:
            age = 0
        if not (20 <= age <= 26):
            return self._json({"ok": False, "error": "Must be between 20-26."})
        why = str(a.get("why", "")).strip()

        with LOCK:
            rows = load_rows()
            n = len(rows) + 1
            row = {
                "n": n,
                "ts": p.get("ts", ""),
                "status": "PENDING",
                "name": str(a.get("name", "")).strip(),
                "age": age,
                "email": str(a.get("email", "")).strip(),
                "phone": str(a.get("phone", "")).strip(),
                "socials": str(a.get("socials", "")).strip(),
                "why": why,
                "working": str(a.get("working", "")).strip(),
                "contrarian": str(a.get("contrarian", "")).strip(),
                "want": str(a.get("want", "")).strip(),
                "ref": str(p.get("ref", ""))[:300],
                "images": save_images(p.get("images") or [], n, "img", 5),
                "id_images": [],
            }
            rows.append(row)
            save_rows(rows)
        return self._json({"ok": True, "n": n})

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet


if __name__ == "__main__":
    handler = partial(Handler, directory=ROOT)
    print(f"REID'S PARTY mock server → http://localhost:{PORT}")
    print(f"  form:  http://localhost:{PORT}/")
    print(f"  admin: http://localhost:{PORT}/admin.html  (passcode: {TOKEN})")
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
