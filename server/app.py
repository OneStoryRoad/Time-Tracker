"""Single-owner, same-origin app. Production refuses to run without an owner hash."""

import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import ValidationError

from server.domain import DomainError, State, apply, find, make_backup
from server.pdf import pdf_invoice

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get("APP_DB", str(ROOT / "data" / "ledger.sqlite")))
TEST_MODE = os.environ.get("APP_TEST_MODE") == "1"
ORIGIN = os.environ.get("APP_ORIGIN", "http://127.0.0.1:8000")
PASSWORD_HASH = os.environ.get("APP_PASSWORD_HASH", "")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
sessions = {}
attempts = defaultdict(deque)


@contextmanager
def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=15)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute(
        "CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, state TEXT NOT NULL)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL)"
    )
    db.execute(
        "INSERT OR IGNORE INTO ledger VALUES(1,0,?)", (State().model_dump_json(),)
    )
    db.commit()
    try:
        with db:
            yield db
    finally:
        db.close()


def snapshot(db):
    version, state = db.execute(
        "SELECT version,state FROM ledger WHERE id=1"
    ).fetchone()
    return {
        "version": version,
        "state": json.loads(state),
        "server_now": int(time.time() * 1000),
    }


def verify_password(password):
    if TEST_MODE:
        return hmac.compare_digest(password, "synthetic-preview-only")
    try:
        alg, salt, expected = PASSWORD_HASH.split("$")
        if alg != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1
        ).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


@app.middleware("http")
async def security(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        if request.method != "GET":
            allowed = {ORIGIN} | (
                {"http://127.0.0.1:5173", "http://localhost:5173"}
                if TEST_MODE
                else set()
            )
            if (
                request.headers.get("origin") not in allowed
                or request.headers.get("x-ledger-request") != "1"
            ):
                return Response("Same-origin request required.", status_code=403)
        if request.url.path != "/api/login":
            token = request.cookies.get("ledger_session", "")
            if sessions.get(token, 0) < time.time():
                sessions.pop(token, None)
                return Response("Sign in to continue.", status_code=401)
    res = await call_next(request)
    res.headers["X-Content-Type-Options"] = "nosniff"
    res.headers["X-Frame-Options"] = "DENY"
    res.headers["Referrer-Policy"] = "no-referrer"
    res.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        res.headers["Cache-Control"] = "no-store"
    return res


async def body(request):
    raw = await request.body()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "Request exceeds 20 MB.")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid JSON.") from None


@app.post("/api/login")
async def login(request: Request, response: Response):
    if not TEST_MODE and (not PASSWORD_HASH or not ORIGIN.startswith("https://")):
        raise HTTPException(503, "Private hosting must be configured before sign-in.")
    if TEST_MODE and request.client.host not in ("127.0.0.1", "::1", "testclient"):
        raise HTTPException(403, "Synthetic preview permits loopback access only.")
    ip = request.client.host
    recent = attempts[ip]
    while recent and recent[0] < time.time() - 900:
        recent.popleft()
    if len(recent) >= 10:
        raise HTTPException(429, "Too many attempts. Try again in 15 minutes.")
    data = await body(request)
    password = data.get("password") if isinstance(data, dict) else None
    if (
        not isinstance(password, str)
        or len(password) > 1024
        or not verify_password(password)
    ):
        recent.append(time.time())
        raise HTTPException(401, "Incorrect password.")
    recent.clear()
    token = secrets.token_urlsafe(32)
    sessions[token] = time.time() + 12 * 3600
    response.set_cookie(
        "ledger_session",
        token,
        httponly=True,
        secure=not TEST_MODE,
        samesite="strict",
        max_age=12 * 3600,
    )
    return {"ok": True, "test_mode": TEST_MODE}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    sessions.pop(request.cookies.get("ledger_session", ""), None)
    response.delete_cookie(
        "ledger_session", secure=not TEST_MODE, httponly=True, samesite="strict"
    )
    return {"ok": True}


@app.get("/api/state")
def state():
    with connect() as db:
        return snapshot(db)


@app.post("/api/command")
async def command(request: Request):
    data = await body(request)
    if (
        not isinstance(data, dict)
        or set(data) != {"id", "version", "kind", "payload"}
        or not isinstance(data["id"], str)
        or not 1 <= len(data["id"]) <= 100
        or type(data["version"]) is not int
        or not isinstance(data["kind"], str)
        or not isinstance(data["payload"], dict)
    ):
        raise HTTPException(422, "Invalid command envelope.")
    digest = hashlib.sha256(
        json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        receipt = db.execute(
            "SELECT hash,result FROM receipts WHERE id=?", (data["id"],)
        ).fetchone()
        if receipt:
            if receipt[0] != digest:
                raise HTTPException(
                    409, "Request ID was already used for a different command."
                )
            return {**snapshot(db), **json.loads(receipt[1])}
        snap = snapshot(db)
        if data["version"] != snap["version"]:
            raise HTTPException(
                409,
                "Ledger changed on another tab/device. Review the queued action before retrying.",
            )
        try:
            new = apply(
                snap["state"], data["kind"], data["payload"], int(time.time() * 1000)
            )
        except (DomainError, ValidationError, ValueError, TypeError, KeyError) as exc:
            msg = (
                str(exc)
                if isinstance(exc, DomainError)
                else "Invalid field values. Check dates, amounts, and required fields."
            )
            raise HTTPException(422, msg) from None
        result = {
            "version": snap["version"] + 1,
            "state": new,
            "server_now": int(time.time() * 1000),
        }
        metadata = {
            "applied_version": result["version"],
            "timer_id": new["timer"]["id"]
            if data["kind"] in ("start", "switch")
            else None,
            "entry_id": new["entries"][-1]["id"] if data["kind"] == "entry" else None,
        }
        encoded = json.dumps(metadata)
        db.execute(
            "UPDATE ledger SET version=?,state=? WHERE id=1",
            (result["version"], json.dumps(new)),
        )
        db.execute("INSERT INTO receipts VALUES(?,?,?)", (data["id"], digest, encoded))
        return {**result, **metadata}


@app.get("/api/backup")
def backup():
    with connect() as db:
        s = snapshot(db)["state"]
    if s["timer"]:
        raise HTTPException(409, "Stop your timer before making a restorable backup.")
    return Response(
        json.dumps(
            make_backup(s, int(time.time() * 1000)),
            indent=2,
        ),
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="time-ledger-backup.json"'
        },
    )


@app.get("/api/export")
def export():
    with connect() as db:
        s = snapshot(db)["state"]
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "entry_id",
            "client",
            "start_utc",
            "end_utc",
            "duration_ms",
            "rate_cents",
            "billable",
            "invoice",
            "notes",
        ]
    )

    def safe(value):
        text = str(value)
        return (
            "'" + text
            if text.startswith(("=", "+", "-", "@", "\t", "\r", "\n"))
            else text
        )

    from datetime import datetime, timezone

    for e in s["entries"]:
        writer.writerow(
            [
                e["id"],
                safe(find(s, "clients", e["client_id"])["name"]),
                datetime.fromtimestamp(e["start"] / 1000, timezone.utc).isoformat(),
                datetime.fromtimestamp(e["end"] / 1000, timezone.utc).isoformat(),
                e["end"] - e["start"],
                e["rate"],
                e["billable"],
                find(s, "invoices", e["invoice_id"])["number"]
                if e["invoice_id"]
                else "",
                safe(e["notes"]),
            ]
        )
    return Response(
        output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="time-ledger-time.csv"'},
    )


@app.get("/api/invoices/{ident}/pdf")
def invoice_pdf(ident: str):
    with connect() as db:
        s = snapshot(db)["state"]
    try:
        i = find(s, "invoices", ident)
    except DomainError:
        raise HTTPException(404, "Invoice not found.") from None
    return Response(
        pdf_invoice(i, [p for p in s["payments"] if p["invoice_id"] == ident]),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{i["number"]}.pdf"'},
    )


@app.get("/{path:path}")
def frontend(path: str):
    dist = ROOT / "dist"
    candidate = (dist / path).resolve()
    if not candidate.is_relative_to(dist.resolve()):
        raise HTTPException(404)
    if candidate.is_file():
        return FileResponse(
            candidate,
            headers={
                "Cache-Control": "no-cache"
                if path in ("sw.js", "index.html")
                else "public, max-age=3600"
            },
        )
    if not (dist / "index.html").exists():
        return Response(
            "Build the interface with npm run build first.", status_code=503
        )
    return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    if not TEST_MODE and (not PASSWORD_HASH or not ORIGIN.startswith("https://")):
        raise SystemExit(
            "Set APP_PASSWORD_HASH and HTTPS APP_ORIGIN. See docs/HOSTING.md. Synthetic local preview: APP_TEST_MODE=1."
        )
    uvicorn.run(
        "server.app:app",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8000")),
        proxy_headers=False,
    )
