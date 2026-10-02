import copy
import json
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from server import app as backend
from server.domain import State, charge, state_checksum

HEADERS = {"Origin": "http://127.0.0.1:8000", "X-Ledger-Request": "1"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "DB", tmp_path / "ledger.sqlite")
    monkeypatch.setattr(backend, "TEST_MODE", True)
    backend.sessions.clear()
    backend.attempts.clear()
    c = TestClient(backend.app, raise_server_exceptions=False)
    assert (
        c.post(
            "/api/login", json={"password": "synthetic-preview-only"}, headers=HEADERS
        ).status_code
        == 200
    )
    return c


def cmd(c, kind, payload, version=None, ident=None):
    v = c.get("/api/state").json()["version"] if version is None else version
    return c.post(
        "/api/command",
        json={
            "id": ident or str(uuid4()),
            "version": v,
            "kind": kind,
            "payload": payload,
        },
        headers=HEADERS,
    )


def seed(c):
    assert (
        cmd(
            c,
            "settings",
            {
                "business": "Synthetic Studio",
                "address": "123 Example Street\nSample City, ZZ 00000",
                "email": "owner@example.invalid",
                "terms": "Please pay by check or transfer. Thank you.",
                "currency": "USD",
            },
        ).status_code
        == 200
    )
    assert (
        cmd(
            c,
            "client",
            {
                "name": "Acorn Design",
                "contact": "Alex Example",
                "email": "alex@example.invalid",
                "address": "42 Test Avenue\nSample City, ZZ 00000",
                "rate": 6000,
            },
        ).status_code
        == 200
    )
    cid = c.get("/api/state").json()["state"]["clients"][0]["id"]
    now = int(time.time() * 1000) - 10000
    for minutes, note in [
        (90, "Brand exploration & concept sketches"),
        (30, "Design review and refinements"),
    ]:
        assert (
            cmd(
                c,
                "entry",
                {
                    "client_id": cid,
                    "start": now - minutes * 60000,
                    "end": now,
                    "notes": note,
                    "billable": True,
                },
            ).status_code
            == 200
        )
    s = c.get("/api/state").json()["state"]
    assert (
        cmd(
            c,
            "invoice",
            {
                "entry_ids": [e["id"] for e in s["entries"]],
                "issued": "2026-10-02",
                "due": "2026-11-01",
            },
        ).status_code
        == 200
    )
    return cid, c.get("/api/state").json()["state"]["invoices"][0]


def test_acceptance_invoice_payments_snapshot_backup(client, tmp_path, monkeypatch):
    cid, i = seed(client)
    assert i["total"] == 12000 and [line["amount"] for line in i["lines"]] == [
        9000,
        3000,
    ]
    pdf0 = client.get(f"/api/invoices/{i['id']}/pdf")
    assert pdf0.status_code == 200 and pdf0.content.startswith(b"%PDF-")
    Path = __import__("pathlib").Path
    Path("evidence").mkdir(exist_ok=True)
    Path("evidence/synthetic-invoice.pdf").write_bytes(pdf0.content)
    assert (
        cmd(
            client,
            "client",
            {
                "id": cid,
                "name": "Renamed client",
                "rate": 9000,
                "address": "Changed address",
            },
        ).status_code
        == 200
    )
    current = client.get("/api/state").json()["state"]
    assert current["invoices"][0] == i and all(
        e["rate"] == 6000 for e in current["entries"]
    )
    for payment, remaining in [(2500, 9500), (9500, 0)]:
        response = cmd(
            client,
            "payment",
            {
                "invoice_id": i["id"],
                "amount": payment,
                "date": "2026-10-02",
                "reference": "Synthetic check",
            },
        )
        assert response.status_code == 200
        s = response.json()["state"]
        assert i["total"] - sum(p["amount"] for p in s["payments"]) == remaining
    assert (
        cmd(
            client,
            "payment",
            {"invoice_id": i["id"], "amount": 1, "date": "2026-10-02"},
        ).status_code
        == 422
    )
    backup = client.get("/api/backup").json()
    assert cmd(client, "restore", {"backup": backup}).status_code == 200
    assert client.get("/api/state").json()["state"] == backup["state"]
    # Fresh database, same complete backup and links/sequence/snapshots/payments.
    monkeypatch.setattr(backend, "DB", tmp_path / "clean.sqlite")
    assert client.get("/api/state").json()["state"] == State().model_dump()
    assert cmd(client, "restore", {"backup": backup}).status_code == 200
    assert client.get("/api/state").json()["state"] == backup["state"]
    pdf = client.get(f"/api/invoices/{i['id']}/pdf")
    Path("evidence/synthetic-paid-invoice.pdf").write_bytes(pdf.content)
    assert pdf.content.startswith(b"%PDF-")


@pytest.mark.parametrize(
    "corruption",
    [
        "amount",
        "total",
        "link",
        "sequence",
        "duplicate",
        "payment",
        "rate",
        "fraction",
        "bool",
        "extra",
        "cycle",
    ],
)
def test_corrupt_restore_is_atomic(client, corruption):
    _, i = seed(client)
    backup = client.get("/api/backup").json()
    bad = copy.deepcopy(backup)
    s = bad["state"]
    if corruption == "amount":
        s["invoices"][0]["lines"][0]["amount"] += 1
    elif corruption == "total":
        s["invoices"][0]["total"] += 1
    elif corruption == "link":
        s["entries"][0]["invoice_id"] = "missing"
    elif corruption == "sequence":
        s["next_invoice"] = 1
    elif corruption == "duplicate":
        s["invoices"][0]["lines"].append(s["invoices"][0]["lines"][0])
    elif corruption == "payment":
        s["payments"] = [
            {
                "id": "x",
                "invoice_id": i["id"],
                "amount": 12001,
                "date": "2026-10-02",
                "reference": "",
            }
        ]
    elif corruption == "rate":
        s["entries"][0]["rate"] = -1
    elif corruption == "fraction":
        s["entries"][0]["rate"] = 6000.5
    elif corruption == "bool":
        s["entries"][0]["rate"] = True
    elif corruption == "extra":
        s["password"] = "must not import"
    elif corruption == "cycle":
        s["entries"][0]["correction_of"] = s["entries"][0]["id"]
    bad["checksum"] = state_checksum(bad["state"])
    before = client.get("/api/state").json()
    assert cmd(client, "restore", {"backup": bad}).status_code == 422
    after = client.get("/api/state").json()
    assert (after["state"], after["version"]) == (before["state"], before["version"])


def test_atomic_timer_refresh_switch_and_retry(client):
    assert cmd(client, "client", {"name": "A", "rate": 6000}).status_code == 200
    assert cmd(client, "client", {"name": "B", "rate": 7500}).status_code == 200
    clients = client.get("/api/state").json()["state"]["clients"]
    at = int(time.time() * 1000) - 120000
    start_id = str(uuid4())
    v = client.get("/api/state").json()["version"]
    payload = {
        "client_id": clients[0]["id"],
        "at": at,
        "notes": "Background work",
        "billable": True,
    }
    response = cmd(client, "start", payload, v, start_id)
    t = response.json()["state"]["timer"]
    assert cmd(client, "start", payload, v, start_id).status_code == 200
    assert client.get("/api/state").json()["state"]["timer"] == t
    # Persistence survives a new connection and process-session loss.
    backend.sessions.clear()
    assert client.get("/api/state").status_code == 401
    client.post(
        "/api/login", json={"password": "synthetic-preview-only"}, headers=HEADERS
    )
    assert client.get("/api/state").json()["state"]["timer"] == t
    v = client.get("/api/state").json()["version"]
    ident = str(uuid4())
    p = {
        "timer_id": t["id"],
        "client_id": clients[1]["id"],
        "at": at + 60000,
        "notes": "Switched",
        "billable": True,
    }
    assert cmd(client, "switch", p, v, ident).status_code == 200
    assert cmd(client, "switch", p, v, ident).status_code == 200
    s = client.get("/api/state").json()["state"]
    t2 = s["timer"]
    assert (
        len(s["entries"]) == 1
        and s["entries"][0]["end"] - s["entries"][0]["start"] == 60000
    )
    v = client.get("/api/state").json()["version"]
    ident = str(uuid4())
    p = {"timer_id": t2["id"], "at": at + 120000}
    assert cmd(client, "stop", p, v, ident).status_code == 200
    assert cmd(client, "stop", p, v, ident).status_code == 200
    s = client.get("/api/state").json()["state"]
    assert (
        s["timer"] is None
        and len(s["entries"]) == 2
        and s["entries"][1]["rate"] == 7500
    )
    assert cmd(client, "stop", p).status_code == 422
    assert (
        cmd(
            client, "stop", {"timer_id": t["id"], "at": at + 120000}, v, ident
        ).status_code
        == 409
    )


@pytest.mark.parametrize("kind", ["invoice", "payment", "stop"])
def test_competing_requests_cannot_duplicate(client, kind):
    cid, i = seed(client)
    if kind == "payment":
        p = {"invoice_id": i["id"], "amount": 2500, "date": "2026-10-02"}
    elif kind == "invoice":
        now = int(time.time() * 1000) - 1000
        cmd(
            client,
            "entry",
            {
                "client_id": cid,
                "start": now - 3600000,
                "end": now,
                "notes": "New time",
                "billable": True,
            },
        )
        s = client.get("/api/state").json()["state"]
        p = {
            "entry_ids": [s["entries"][-1]["id"]],
            "issued": "2026-10-02",
            "due": "2026-11-01",
        }
    else:
        cmd(client, "start", {"client_id": cid, "at": int(time.time() * 1000) - 1000})
        t = client.get("/api/state").json()["state"]["timer"]
        p = {"timer_id": t["id"], "at": int(time.time() * 1000)}
    v = client.get("/api/state").json()["version"]
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(lambda _: cmd(client, kind, p, v).status_code, range(2)))
    assert sorted(codes) == [200, 409]
    s = client.get("/api/state").json()["state"]
    assert len(s["payments"]) == (1 if kind == "payment" else 0)
    assert len(s["invoices"]) == (2 if kind == "invoice" else 1)
    assert len(s["entries"]) == (3 if kind in ("stop", "invoice") else 2)


def test_replay_same_id_and_snapshot_immutability(client):
    cid, i = seed(client)
    e = client.get("/api/state").json()["state"]["entries"][0]
    assert (
        cmd(
            client, "entry", {k: v for k, v in e.items() if k != "invoice_id"}
        ).status_code
        == 422
    )
    assert cmd(client, "delete_entry", {"id": e["id"]}).status_code == 422
    assert (
        cmd(
            client,
            "invoice",
            {"entry_ids": [e["id"]], "issued": "2026-10-02", "due": "2026-11-01"},
        ).status_code
        == 422
    )
    v = client.get("/api/state").json()["version"]
    ident = str(uuid4())
    p = {"invoice_id": i["id"], "amount": 2500, "date": "2026-10-02"}
    for _ in range(3):
        assert cmd(client, "payment", p, v, ident).status_code == 200
    assert len(client.get("/api/state").json()["state"]["payments"]) == 1


def test_void_and_correction_history(client):
    cid, i = seed(client)
    assert (
        cmd(
            client,
            "void_invoice",
            {"id": i["id"], "reason": "Wrong scope", "date": "2026-10-02"},
        ).status_code
        == 200
    )
    s = client.get("/api/state").json()["state"]
    e = s["entries"][0]
    assert s["invoices"][0]["voided"] and e["invoice_id"] == i["id"]
    assert (
        cmd(
            client,
            "payment",
            {"invoice_id": i["id"], "amount": 1, "date": "2026-10-02"},
        ).status_code
        == 422
    )
    p = {
        "client_id": cid,
        "start": e["start"],
        "end": e["end"] - 600000,
        "notes": "Corrected scope",
        "billable": True,
        "correction_of": e["id"],
    }
    assert cmd(client, "entry", p).status_code == 200
    assert cmd(client, "entry", p).status_code == 422
    corrected = client.get("/api/state").json()["state"]["entries"][-1]
    assert (
        cmd(
            client,
            "invoice",
            {
                "entry_ids": [corrected["id"]],
                "issued": "2026-10-02",
                "due": "2026-11-01",
            },
        ).status_code
        == 200
    )
    assert (
        client.get("/api/state").json()["state"]["invoices"][-1]["number"]
        == "INV-00002"
    )
    assert client.get(f"/api/invoices/{i['id']}/pdf").status_code == 200


def test_auth_download_logout_csrf_bruteforce(client):
    _, i = seed(client)
    assert client.post("/api/command", json={}).status_code == 403
    assert (
        client.post(
            "/api/logout",
            json={},
            headers={"Origin": "https://evil.invalid", "X-Ledger-Request": "1"},
        ).status_code
        == 403
    )
    assert client.post("/api/logout", json={}, headers=HEADERS).status_code == 200
    for path in [
        "/api/state",
        "/api/backup",
        "/api/export",
        f"/api/invoices/{i['id']}/pdf",
    ]:
        assert client.get(path).status_code == 401
    for _ in range(10):
        assert (
            client.post(
                "/api/login", json={"password": "wrong"}, headers=HEADERS
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/login", json={"password": "wrong"}, headers=HEADERS
        ).status_code
        == 429
    )


def test_failed_database_save_never_commits(client):
    before = client.get("/api/state").json()
    with backend.connect() as db:
        db.execute(
            "CREATE TRIGGER fail_save BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END"
        )
    assert (
        cmd(client, "client", {"name": "Failed save", "rate": 1000}).status_code == 500
    )
    after = client.get("/api/state").json()
    assert before["state"] == after["state"] and before["version"] == after["version"]
    with backend.connect() as db:
        assert db.execute("SELECT count(*) FROM receipts").fetchone()[0] == 0


@pytest.mark.parametrize(
    "start,end,rate,expected",
    [
        (0, 9000000, 6000, 15000),
        (0, 5400000, 6000, 9000),
        (0, 1800000, 6000, 3000),
        (0, 1800000, 1, 1),
        (0, 1799999, 1, 0),
        (0, 1, 6000, 0),
    ],
)
def test_rounding(start, end, rate, expected):
    assert charge(start, end, rate) == expected


@pytest.mark.parametrize(
    "bad",
    [
        {"rate": 1.5},
        {"rate": True},
        {"rate": -1},
        {"rate": 100000001},
        {"name": "  "},
        {"unknown": 1},
    ],
)
def test_strict_input_validation(client, bad):
    assert cmd(client, "client", {"name": "X", "rate": 6000, **bad}).status_code == 422


def test_future_and_negative_time_currency_and_backup_running(client):
    cid, _ = seed(client)
    now = int(time.time() * 1000)
    for start, end in [(now, now - 1), (now, now + 120000)]:
        assert (
            cmd(
                client,
                "entry",
                {
                    "client_id": cid,
                    "start": start,
                    "end": end,
                    "notes": "bad",
                    "billable": True,
                },
            ).status_code
            == 422
        )
    settings = client.get("/api/state").json()["state"]["settings"]
    assert cmd(client, "settings", {**settings, "currency": "EUR"}).status_code == 422
    assert cmd(client, "start", {"client_id": cid, "at": now}).status_code == 200
    assert client.get("/api/backup").status_code == 409


def test_long_unicode_pdf_and_export_formula_safety(client):
    cmd(client, "settings", {"business": "Café Studio", "currency": "USD"})
    cmd(client, "client", {"name": "=Example", "rate": 6000})
    cid = client.get("/api/state").json()["state"]["clients"][0]["id"]
    now = int(time.time() * 1000) - 1000
    assert (
        cmd(
            client,
            "entry",
            {
                "client_id": cid,
                "start": now - 3600000,
                "end": now,
                "notes": "Résumé & design <review>\n" * 140,
                "billable": True,
            },
        ).status_code
        == 200
    )
    e = client.get("/api/state").json()["state"]["entries"][0]
    assert (
        cmd(
            client,
            "invoice",
            {"entry_ids": [e["id"]], "issued": "2026-10-02", "due": "2026-11-01"},
        ).status_code
        == 200
    )
    i = client.get("/api/state").json()["state"]["invoices"][0]
    r = client.get(f"/api/invoices/{i['id']}/pdf")
    assert r.status_code == 200
    __import__("pathlib").Path("evidence/long-unicode-invoice.pdf").write_bytes(
        r.content
    )
    assert "'=Example" in client.get("/api/export").text
    assert (
        json.loads(client.get("/api/backup").text)["state"]["invoices"][0]["client"][
            "name"
        ]
        == "=Example"
    )


def test_checksum_rejects_otherwise_valid_edits(client):
    seed(client)
    backup = client.get("/api/backup").json()
    backup["state"]["clients"][0]["name"] = "Edited without checksum"
    before = client.get("/api/state").json()
    assert cmd(client, "restore", {"backup": backup}).status_code == 422
    assert client.get("/api/state").json()["state"] == before["state"]


def test_production_auth_cookie_and_fail_closed_configuration(tmp_path, monkeypatch):
    import hashlib

    monkeypatch.setattr(backend, "DB", tmp_path / "private.sqlite")
    monkeypatch.setattr(backend, "TEST_MODE", False)
    monkeypatch.setattr(backend, "ORIGIN", "https://private.example.invalid")
    monkeypatch.setattr(backend, "PASSWORD_HASH", "")
    headers = {"Origin": "https://private.example.invalid", "X-Ledger-Request": "1"}
    with TestClient(backend.app, base_url="https://private.example.invalid") as c:
        assert c.get("/api/state").status_code == 401
        assert (
            c.post(
                "/api/login",
                json={"password": "synthetic-preview-only"},
                headers=headers,
            ).status_code
            == 503
        )
        # Deterministic synthetic fixture only, never stored as a production credential.
        salt = bytes.fromhex("00000000000000000000000000000000")
        derived = hashlib.scrypt(
            b"synthetic-owner-fixture", salt=salt, n=16384, r=8, p=1
        ).hex()
        monkeypatch.setattr(backend, "PASSWORD_HASH", f"scrypt${salt.hex()}${derived}")
        assert (
            c.post(
                "/api/login",
                json={"password": "synthetic-preview-only"},
                headers=headers,
            ).status_code
            == 401
        )
        r = c.post(
            "/api/login", json={"password": "synthetic-owner-fixture"}, headers=headers
        )
        assert r.status_code == 200
        cookie = r.headers["set-cookie"]
        assert all(flag in cookie for flag in ("HttpOnly", "Secure", "SameSite=strict"))
        assert c.get("/api/state").status_code == 200
        assert c.post("/api/logout", json={}, headers=headers).status_code == 200
        assert c.get("/api/backup").status_code == 401
