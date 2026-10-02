"""Validated ledger. All monetary values are cents, durations integer milliseconds."""

import hashlib
import hmac
import json
from copy import deepcopy
from datetime import date
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
)

MAX_MONEY = 100_000_000
MAX_DURATION = 365 * 24 * 3_600_000
Money = Annotated[StrictInt, Field(ge=0, le=MAX_MONEY)]
Timestamp = Annotated[StrictInt, Field(ge=946684800000, le=4102444800000)]
Text = Annotated[StrictStr, Field(max_length=4000)]
Id = Annotated[StrictStr, Field(min_length=1, max_length=100)]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Client(Model):
    id: Id
    name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    contact: Text = ""
    email: Annotated[StrictStr, Field(max_length=254)] = ""
    address: Text = ""
    rate: Money
    archived: StrictBool = False


class Entry(Model):
    id: Id
    client_id: Id
    start: Timestamp
    end: Timestamp
    notes: Text = ""
    rate: Money
    billable: StrictBool = True
    invoice_id: Id | None = None
    correction_of: Id | None = None


class Timer(Model):
    id: Id
    client_id: Id
    start: Timestamp
    rate: Money
    notes: Text = ""
    billable: StrictBool = True


class Line(Model):
    entry_id: Id
    start: Timestamp
    end: Timestamp
    notes: Text
    rate: Money
    amount: Money
    correction_of: Id | None = None


class Settings(Model):
    business: Annotated[StrictStr, Field(min_length=1, max_length=120)] = (
        "Your business"
    )
    address: Text = ""
    email: Annotated[StrictStr, Field(max_length=254)] = ""
    terms: Text = "Thank you for your business. Please pay by the due date."
    currency: Literal["USD", "CAD", "GBP", "EUR", "AUD"] = "USD"


class Invoice(Model):
    id: Id
    number: Annotated[StrictStr, Field(pattern=r"^INV-[0-9]{5,}$", max_length=32)]
    client: Client
    issuer: Settings
    issued: StrictStr
    due: StrictStr
    lines: Annotated[list[Line], Field(min_length=1, max_length=1000)]
    total: Money
    voided: StrictBool = False
    void_reason: Text = ""
    void_date: StrictStr = ""

    @field_validator("issued", "due")
    @classmethod
    def dates(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("Use an ISO calendar date")
        return value


class Payment(Model):
    id: Id
    invoice_id: Id
    amount: Annotated[StrictInt, Field(gt=0, le=MAX_MONEY)]
    date: StrictStr
    reference: Text = ""

    @field_validator("date")
    @classmethod
    def dates(cls, value):
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("Use an ISO calendar date")
        return value


class State(Model):
    schema_version: Literal[1] = 1
    settings: Settings = Field(default_factory=Settings)
    clients: Annotated[list[Client], Field(max_length=10000)] = []
    entries: Annotated[list[Entry], Field(max_length=100000)] = []
    invoices: Annotated[list[Invoice], Field(max_length=10000)] = []
    payments: Annotated[list[Payment], Field(max_length=100000)] = []
    timer: Timer | None = None
    next_invoice: Annotated[StrictInt, Field(ge=1, le=1000000000)] = 1


class DomainError(ValueError):
    pass


def charge(start, end, rate):
    """Round each line to nearest cent, half up, without floats."""
    return ((end - start) * rate + 1_800_000) // 3_600_000


def duration(start, end):
    if not 0 < end - start <= MAX_DURATION:
        raise DomainError("Time must end after it starts and span at most 365 days.")


def state_checksum(state):
    return hashlib.sha256(
        json.dumps(
            state, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()


def make_backup(state, now):
    return {
        "format": "time-ledger-backup-v1",
        "exported_at": now,
        "state": state,
        "checksum": state_checksum(state),
    }


def validate_state(data):
    s = State.model_validate(data).model_dump()
    if not s["settings"]["business"].strip() or any(
        not c["name"].strip() for c in s["clients"]
    ):
        raise DomainError("Business and client names cannot be blank.")
    maps = {}
    for table in ("clients", "entries", "invoices", "payments"):
        maps[table] = {x["id"]: x for x in s[table]}
        if len(maps[table]) != len(s[table]):
            raise DomainError("Duplicate IDs in backup.")
    clients, entries, invoices = maps["clients"], maps["entries"], maps["invoices"]
    numbers = set()
    billed = set()
    corrections = set()
    for e in entries.values():
        duration(e["start"], e["end"])
        if e["correction_of"]:
            original = entries.get(e["correction_of"])
            if (
                not original
                or not original["invoice_id"]
                or not invoices.get(original["invoice_id"], {}).get("voided")
                or original["client_id"] != e["client_id"]
                or original["id"] in corrections
                or original["id"] == e["id"]
            ):
                raise DomainError(
                    "Corrections require unique time linked to a voided invoice for the same client."
                )
            corrections.add(original["id"])
            seen = {e["id"]}
            ancestor = original
            while ancestor:
                if ancestor["id"] in seen:
                    raise DomainError("Correction links cannot form a cycle.")
                seen.add(ancestor["id"])
                ancestor = (
                    entries.get(ancestor["correction_of"])
                    if ancestor["correction_of"]
                    else None
                )
        if e["client_id"] not in clients or (
            e["invoice_id"] and e["invoice_id"] not in invoices
        ):
            raise DomainError("An entry refers to a missing client or invoice.")
        if charge(e["start"], e["end"], e["rate"]) > MAX_MONEY:
            raise DomainError("Entry amount exceeds the supported limit.")
    for i in invoices.values():
        if (
            i["client"]["id"] not in clients
            or i["due"] < i["issued"]
            or i["number"] in numbers
        ):
            raise DomainError("Invalid invoice client, date, or number.")
        if i["voided"]:
            if (
                not i["void_reason"].strip()
                or date.fromisoformat(i["void_date"]).isoformat() != i["void_date"]
            ):
                raise DomainError("Voided invoices need a date and reason.")
        elif i["void_date"] or i["void_reason"]:
            raise DomainError("Active invoices cannot have void details.")
        if (
            int(i["number"][4:]) < 1
            or i["issuer"]["currency"] != s["settings"]["currency"]
        ):
            raise DomainError(
                "Invoice number and currency must match ledger conventions."
            )
        numbers.add(i["number"])
        if int(i["number"][4:]) >= s["next_invoice"]:
            raise DomainError("Invoice sequence would reuse an existing number.")
        total = 0
        for line in i["lines"]:
            e = entries.get(line["entry_id"])
            if (
                not e
                or e["id"] in billed
                or e["invoice_id"] != i["id"]
                or not e["billable"]
                or e["client_id"] != i["client"]["id"]
            ):
                raise DomainError("Invoice links are inconsistent or duplicate billed.")
            for k in ("start", "end", "notes", "rate", "correction_of"):
                if line[k] != e[k]:
                    raise DomainError("Finalized invoice and entry snapshots disagree.")
            if line["amount"] != charge(line["start"], line["end"], line["rate"]):
                raise DomainError("Invoice line amount is incorrect.")
            total += line["amount"]
            billed.add(e["id"])
        if total != i["total"]:
            raise DomainError("Invoice total is incorrect.")
    if billed != {e["id"] for e in entries.values() if e["invoice_id"]}:
        raise DomainError("A billed entry has no matching invoice line.")
    balances = {i["id"]: i["total"] for i in invoices.values()}
    for p in s["payments"]:
        if p["invoice_id"] not in balances or invoices[p["invoice_id"]]["voided"]:
            raise DomainError("Payment refers to a missing invoice.")
        balances[p["invoice_id"]] -= p["amount"]
        if balances[p["invoice_id"]] < 0:
            raise DomainError("Payments exceed invoice total.")
    if s["timer"] and s["timer"]["client_id"] not in clients:
        raise DomainError("Timer refers to a missing client.")
    return s


def find(s, table, ident):
    for item in s[table]:
        if item["id"] == ident:
            return item
    raise DomainError(f"{table.title()} record was not found.")


def keys(payload, allowed, required=()):
    if set(payload) - set(allowed) or set(required) - set(payload):
        raise DomainError("Command has missing or unsupported fields.")


def apply(state, kind, p, now):
    s = deepcopy(state)
    if kind == "client":
        keys(
            p,
            ("id", "name", "contact", "email", "address", "rate", "archived"),
            ("name", "rate"),
        )
        c = Client.model_validate({**p, "id": p.get("id") or str(uuid4())}).model_dump()
        if not c["name"].strip():
            raise DomainError("Client name is required.")
        if p.get("id"):
            old = find(s, "clients", p["id"])
            s["clients"][s["clients"].index(old)] = c
        else:
            s["clients"].append(c)
    elif kind == "settings":
        settings = Settings.model_validate(p).model_dump()
        if (s["entries"] or s["timer"]) and settings["currency"] != s["settings"][
            "currency"
        ]:
            raise DomainError("Currency cannot change after time is recorded.")
        s["settings"] = settings
    elif kind in ("start", "switch"):
        keys(
            p,
            ("client_id", "at", "notes", "billable", "timer_id", "stop_notes"),
            ("client_id", "at"),
        )
        c = find(s, "clients", p["client_id"])
        if c["archived"]:
            raise DomainError("Choose an active client.")
        if kind == "start" and s["timer"]:
            raise DomainError("A timer is already running. Refresh or switch clients.")
        if kind == "switch":
            stop_timer(s, p, now)
        s["timer"] = Timer(
            id=str(uuid4()),
            client_id=c["id"],
            start=p["at"],
            rate=c["rate"],
            notes=p.get("notes", ""),
            billable=p.get("billable", True),
        ).model_dump()
        check_at(p["at"], now)
    elif kind == "stop":
        keys(p, ("timer_id", "at", "stop_notes"), ("timer_id", "at"))
        stop_timer(s, p, now)
    elif kind == "timer_notes":
        keys(p, ("timer_id", "notes"), ("timer_id", "notes"))
        if not s["timer"] or s["timer"]["id"] != p["timer_id"]:
            raise DomainError("This timer is no longer active.")
        s["timer"]["notes"] = p["notes"]
    elif kind == "entry":
        keys(
            p,
            (
                "id",
                "client_id",
                "start",
                "end",
                "notes",
                "rate",
                "billable",
                "correction_of",
            ),
            ("client_id", "start", "end", "notes", "billable"),
        )
        c = find(s, "clients", p["client_id"])
        old = find(s, "entries", p["id"]) if p.get("id") else None
        if old and old["invoice_id"]:
            raise DomainError("Finalized invoice time cannot be edited.")
        rate = p.get("rate", old["rate"] if old else c["rate"])
        e = Entry.model_validate(
            {
                **p,
                "id": p.get("id") or str(uuid4()),
                "rate": rate,
                "correction_of": p.get(
                    "correction_of", old["correction_of"] if old else None
                ),
            }
        ).model_dump()
        check_at(e["end"], now)
        if old:
            s["entries"][s["entries"].index(old)] = e
        else:
            s["entries"].append(e)
    elif kind == "delete_entry":
        keys(p, ("id",), ("id",))
        e = find(s, "entries", p["id"])
        if e["invoice_id"]:
            raise DomainError("Finalized invoice time cannot be deleted.")
        s["entries"].remove(e)
    elif kind == "invoice":
        keys(p, ("entry_ids", "issued", "due"), ("entry_ids", "issued", "due"))
        if (
            not isinstance(p["entry_ids"], list)
            or not p["entry_ids"]
            or len(p["entry_ids"]) != len(set(p["entry_ids"]))
        ):
            raise DomainError("Select unique unbilled time entries.")
        selected = [find(s, "entries", x) for x in p["entry_ids"]]
        cid = selected[0]["client_id"]
        if any(
            e["invoice_id"] or not e["billable"] or e["client_id"] != cid
            for e in selected
        ):
            raise DomainError("Select unbilled, billable entries for one client.")
        if s["settings"]["business"] == "Your business":
            raise DomainError(
                "Set your business name in Settings before finalizing an invoice."
            )
        i = Invoice(
            id=str(uuid4()),
            number=f"INV-{s['next_invoice']:05d}",
            client=find(s, "clients", cid),
            issuer=s["settings"],
            issued=p["issued"],
            due=p["due"],
            lines=[
                Line(
                    entry_id=e["id"],
                    start=e["start"],
                    end=e["end"],
                    notes=e["notes"],
                    rate=e["rate"],
                    correction_of=e["correction_of"],
                    amount=charge(e["start"], e["end"], e["rate"]),
                )
                for e in selected
            ],
            total=sum(charge(e["start"], e["end"], e["rate"]) for e in selected),
        ).model_dump()
        s["next_invoice"] += 1
        s["invoices"].append(i)
        for e in selected:
            e["invoice_id"] = i["id"]
    elif kind == "void_invoice":
        keys(p, ("id", "reason", "date"), ("id", "reason", "date"))
        i = find(s, "invoices", p["id"])
        if i["voided"] or any(x["invoice_id"] == i["id"] for x in s["payments"]):
            raise DomainError(
                "Only unpaid active invoices can be voided. Correct payment records first if needed."
            )
        i.update(voided=True, void_reason=p["reason"], void_date=p["date"])
    elif kind == "payment":
        keys(
            p,
            ("invoice_id", "amount", "date", "reference"),
            ("invoice_id", "amount", "date"),
        )
        s["payments"].append(Payment(id=str(uuid4()), **p).model_dump())
    elif kind == "delete_payment":
        keys(p, ("id",), ("id",))
        s["payments"].remove(find(s, "payments", p["id"]))
    elif kind == "restore":
        keys(p, ("backup",), ("backup",))
        if s["timer"]:
            raise DomainError("Stop your running timer before restoring.")
        b = p["backup"]
        if (
            set(b) != {"format", "exported_at", "state", "checksum"}
            or b["format"] != "time-ledger-backup-v1"
        ):
            raise DomainError("Unsupported backup format.")
        if not isinstance(b["checksum"], str) or not hmac.compare_digest(
            b["checksum"], state_checksum(b["state"])
        ):
            raise DomainError(
                "Backup checksum does not match. The file is damaged or has been edited."
            )
        s = validate_state(b["state"])
        if s["timer"]:
            raise DomainError(
                "Backup contains a running timer. Stop it before taking a restorable backup."
            )
    else:
        raise DomainError("Unknown command.")
    return validate_state(s)


def check_at(at, now):
    if type(at) is not int or not 946684800000 <= at <= now + 60_000:
        raise DomainError(
            "Timestamp is invalid or in the future. Check your device clock."
        )


def stop_timer(s, p, now):
    t = s["timer"]
    if not t or t["id"] != p.get("timer_id"):
        raise DomainError("This timer is no longer active. Refresh before stopping.")
    check_at(p["at"], now)
    duration(t["start"], p["at"])
    s["entries"].append(
        Entry(
            id=t["id"],
            client_id=t["client_id"],
            start=t["start"],
            end=p["at"],
            rate=t["rate"],
            notes=p.get("stop_notes", t["notes"]),
            billable=t["billable"],
        ).model_dump()
    )
    s["timer"] = None
