import { Login, Empty, TimerPanel, useDialogFocus } from "./components";
import { ModalContent } from "./modals";
import type { Modal } from "./ui-types";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Clock3,
  Check,
  Users,
  Rows3,
  FileText,
  Plus,
  ArrowUpRight,
  Settings as SettingsIcon,
  ChevronRight,
  WifiOff,
  RefreshCw,
  LogOut,
  X,
  Leaf,
} from "lucide-react";
import { amount, duration, localDate, money } from "./types";
import type { Command, Entry, Invoice } from "./types";
import { api, ApiError, project, readCache, saveCache } from "./store";
import type { Cache } from "./store";
import "./style.css";

type Tab = "Today" | "Clients" | "Time" | "Invoices";
const channel = new BroadcastChannel("time-ledger-updates");
const empty: Cache = { snapshot: null, queue: [], projected: null };
const lock = <T,>(fn: () => Promise<T>) =>
  navigator.locks.request("time-ledger-writer", fn);
function App() {
  const [cache, setCache] = useState<Cache>(empty),
    [ready, setReady] = useState(false),
    [signed, setSigned] = useState(false),
    [tab, setTab] = useState<Tab>("Today"),
    [modal, setModal] = useState<Modal>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [offline, setOffline] = useState(!navigator.onLine),
    [conflict, setConflict] = useState(false),
    [now, setNow] = useState(Date.now()),
    [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState("unbilled"),
    [search, setSearch] = useState("");
  const guard = useRef(false),
    cacheRef = useRef(cache);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(!!modal, dialogRef, () => setModal(null), guard);
  cacheRef.current = cache;
  const s = cache.projected ?? cache.snapshot?.state;
  const commit = async (c: Cache) => {
    await saveCache(c);
    cacheRef.current = c;
    setCache(c);
    channel.postMessage("changed");
  };
  const flush = async () => {
    let c = await readCache();
    while (c.queue.length) {
      const cmd = c.queue[0];
      try {
        const snap = await api("command", cmd);
        const next = c.queue.slice(1).map((q) => {
          const p = { ...q.payload };
          for (const key of ["timer_id", "id"])
            if (p[key] === "pending-" + cmd.id)
              p[key] = key === "timer_id" ? snap.timer_id : snap.entry_id;
          return { ...q, payload: p };
        });
        let projected = snap.state;
        for (const q of next) projected = project(projected, q);
        c = {
          snapshot: snap,
          queue: next,
          projected: next.length ? projected : null,
        };
        await commit(c);
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 401) setSigned(false);
          else {
            setConflict(true);
            setError(e.message);
          }
          throw e;
        } else {
          setOffline(true);
          setNotice("Saved on this device. Reconnect to sync.");
        }
        return;
      }
    }
    try {
      const snap = await api("state");
      await commit({ snapshot: snap, queue: [], projected: null });
      setSigned(true);
      setOffline(false);
      setConflict(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSigned(false);
      else setOffline(true);
    }
  };
  const sync = async () => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    try {
      await lock(flush);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Storage unavailable.");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    let alive = true;
    const changed = async () => {
      const c = await readCache();
      if (!alive) return;
      cacheRef.current = c;
      setCache(c);
      if (!c.snapshot) {
        setSigned(false);
        setModal(null);
      }
    };
    channel.addEventListener("message", changed);
    readCache()
      .then((c) => {
        if (!alive) return;
        cacheRef.current = c;
        setCache(c);
        setSigned(!!c.snapshot);
        setReady(true);
        void sync();
      })
      .catch(() => {
        setError(
          "Device storage is unavailable. Enable storage before tracking time.",
        );
        setReady(true);
      });
    const interval = setInterval(() => setNow(Date.now()), 1000);
    const online = () => void sync(),
      offlineFn = () => setOffline(true),
      visible = () => {
        if (document.visibilityState === "visible") void sync();
      };
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineFn);
    window.addEventListener("focus", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      channel.removeEventListener("message", changed);
      clearInterval(interval);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offlineFn);
      window.removeEventListener("focus", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const mutate = async (kind: string, payload: Record<string, unknown>) => {
    if (guard.current) throw Error("Please wait for the current action.");
    guard.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await lock(async () => {
        const c = await readCache();
        if (!c.snapshot) throw Error("Sign in first.");
        if (
          c.snapshot.version !== cache.snapshot?.version ||
          c.queue.length !== cache.queue.length
        )
          throw Error(
            "Another tab updated the ledger. Sync and review before saving.",
          );
        if (conflict)
          throw Error("Resolve the pending action before making changes.");
        const canOffline = [
          "start",
          "stop",
          "switch",
          "timer_notes",
          "entry",
        ].includes(kind);
        if (c.queue.length && !canOffline)
          throw Error("Sync pending time before this action.");
        if (!navigator.onLine && !canOffline)
          throw Error("Reconnect to make this change.");
        const cmd: Command = {
          id: crypto.randomUUID(),
          version: c.snapshot.version + c.queue.length,
          kind,
          payload,
        };
        // Persist the command before sending so a lost response is safely retried.
        const projected = canOffline
          ? project(c.projected ?? c.snapshot.state, cmd)
          : c.projected;
        await commit({ ...c, queue: [...c.queue, cmd], projected });
        await flush();
        if (cacheRef.current.queue.length && !canOffline)
          throw Error("Action is pending. Resolve it before continuing.");
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
      throw e;
    } finally {
      guard.current = false;
      setBusy(false);
    }
  };
  const run = (kind: string, p: Record<string, unknown>) =>
    void mutate(kind, p).catch(() => {});
  const download = async (path: string) => {
    if (cache.queue.length || offline) {
      setError("Reconnect and sync before downloading.");
      return;
    }
    try {
      const r = await fetch("/api/" + path);
      if (!r.ok) {
        let msg = await r.text();
        try {
          msg = JSON.parse(msg).detail;
        } catch {
          /* plain response */
        }
        throw Error(msg);
      }
      const blob = await r.blob();
      downloadBlob(
        blob,
        r.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "export",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const logout = async () => {
    if (cache.queue.length) {
      setError(
        "Sync or export and discard pending actions before signing out.",
      );
      return;
    }
    try {
      await api("logout", {});
      await lock(() => commit(empty));
      setSigned(false);
      setModal(null);
      setNotice("Signed out. Device ledger cache cleared.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const discard = async () => {
    if (
      !confirm(
        "Discard ALL queued actions on this device? Download pending actions first if you need to recover them. Confirmed server data will stay intact.",
      )
    )
      return;
    await lock(async () => {
      const c = await readCache();
      await commit({ ...c, queue: [], projected: null });
      setConflict(false);
      setError("");
      await flush();
    });
  };
  if (!ready) return <div className="loading">Opening your ledger…</div>;
  if (!signed || !s)
    return (
      <Login
        error={error}
        notice={notice}
        onLogin={async (password) => {
          try {
            await api("login", { password });
            setSigned(true);
            setError("");
            await sync();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    );
  const currency = s.settings.currency,
    active = s.clients.filter((c) => !c.archived),
    timer = s.timer;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const today = s.entries.filter(
    (e) => e.start < dayEnd.getTime() && e.end > dayStart.getTime(),
  );
  const todayDuration =
    today.reduce(
      (sum, e) =>
        sum +
        Math.max(
          0,
          Math.min(e.end, dayEnd.getTime()) -
            Math.max(e.start, dayStart.getTime()),
        ),
      0,
    ) +
    (timer ? Math.max(0, now - Math.max(timer.start, dayStart.getTime())) : 0);
  const unbilled = s.entries.filter((e) => e.billable && !e.invoice_id);
  const balance = (i: Invoice) =>
    i.voided
      ? 0
      : i.total -
        s.payments
          .filter((p) => p.invoice_id === i.id)
          .reduce((sum, p) => sum + p.amount, 0);
  const outstanding = s.invoices.reduce((sum, i) => sum + balance(i), 0);
  const clientName = (id: string) =>
    s.clients.find((c) => c.id === id)?.name ?? "Client";
  const entryRows = (entries: Entry[], selectable = false) =>
    entries.map((e) => (
      <div className="entry-row" key={e.id}>
        {selectable && e.billable && !e.invoice_id && (
          <input
            type="checkbox"
            aria-label={`Select ${e.notes || clientName(e.client_id)}`}
            checked={selected.includes(e.id)}
            onChange={() =>
              setSelected((prev) =>
                prev.includes(e.id)
                  ? prev.filter((id) => id !== e.id)
                  : [...prev, e.id],
              )
            }
          />
        )}
        <div className="avatar">
          {clientName(e.client_id).slice(0, 2).toUpperCase()}
        </div>
        <button
          className="row-main"
          onClick={() => setModal({ kind: "entry", entry: e })}
        >
          <strong>{clientName(e.client_id)}</strong>
          <span>
            {e.notes || "No note"} ·{" "}
            {new Date(e.start).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </button>
        <div className="row-value">
          <strong>{duration(e.end - e.start)}</strong>
          <span>
            {e.invoice_id
              ? s.invoices.find((i) => i.id === e.invoice_id)?.number
              : e.billable
                ? money(amount(e), currency)
                : "Nonbillable"}
          </span>
        </div>
      </div>
    ));
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setTab("Today");
          }}
        >
          <span className="brand-mark">
            <Clock3 size={22} />
          </span>
          <span>
            Time Ledger<small>A little more headspace.</small>
          </span>
        </a>
        <nav>
          {(["Today", "Clients", "Time", "Invoices"] as Tab[]).map((t, i) => {
            const Icon = [Clock3, Users, Rows3, FileText][i];
            return (
              <button
                key={t}
                aria-label={t}
                className={tab === t ? "active" : ""}
                onClick={() => {
                  setTab(t);
                  setSearch("");
                }}
              >
                <Icon size={21} />
                <span>{t}</span>
                {t === "Invoices" && s.invoices.length > 0 && (
                  <small>{s.invoices.length}</small>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="private">
            <Leaf size={16} /> Your work. Your ledger.
          </div>
          <button
            className="quiet"
            onClick={() => setModal({ kind: "settings" })}
          >
            <SettingsIcon size={18} /> Settings & backups
          </button>
          <button className="quiet" onClick={() => void logout()}>
            <LogOut size={18} /> Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span className="mobile-brand">
            <Clock3 size={19} /> Time Ledger
          </span>
          <span className={"sync-state " + (offline ? "warn" : "")}>
            <span className="dot" />
            {offline
              ? "Offline · device copy"
              : cache.queue.length
                ? `${cache.queue.length} pending`
                : "Saved & synced"}
          </span>
          <button
            className="icon-button"
            aria-label="Sync ledger"
            onClick={() => void sync()}
            disabled={busy}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="icon-button mobile-settings"
            aria-label="Settings and backups"
            onClick={() => setModal({ kind: "settings" })}
          >
            <SettingsIcon size={19} />
          </button>
        </header>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {cache.queue.length > 0 && (
          <div className="pending">
            <WifiOff size={18} />
            <div>
              <strong>
                {cache.queue.length} action{cache.queue.length === 1 ? "" : "s"}{" "}
                saved on this device
              </strong>
              <p>
                {conflict
                  ? "A conflict needs review. Export the pending actions before discarding, then re-enter the intended change against the current ledger."
                  : "Keep this browser’s storage until the actions sync. Your timer uses the original timestamps."}
              </p>
              <button
                className="text-button"
                onClick={() =>
                  downloadBlob(
                    new Blob([JSON.stringify(cache.queue, null, 2)], {
                      type: "application/json",
                    }),
                    "pending-actions.json",
                  )
                }
              >
                Export pending actions
              </button>
              {conflict && (
                <button
                  className="text-button danger"
                  onClick={() => void discard()}
                >
                  Discard queued actions & refresh
                </button>
              )}
            </div>
          </div>
        )}
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {tab === "Today"
                  ? new Date(now).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                  : "YOUR PRIVATE WORKSPACE"}
              </div>
              <h1>{tab === "Today" ? "Make time count." : tab}</h1>
              <p>
                {tab === "Today"
                  ? "A clear view of your work, one day at a time."
                  : tab === "Clients"
                    ? "Good work starts with good relationships."
                    : tab === "Time"
                      ? "Every hour, accounted for."
                      : "From work completed to payment received."}
              </p>
            </div>
            {tab !== "Today" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  tab === "Clients"
                    ? setModal({ kind: "client" })
                    : tab === "Time"
                      ? setModal({ kind: "entry" })
                      : (setTab("Time"), setFilter("unbilled"))
                }
              >
                <Plus size={18} />
                {tab === "Clients"
                  ? "Add client"
                  : tab === "Time"
                    ? "Add time"
                    : "Create invoice"}
              </button>
            )}
          </div>
          {tab === "Today" && (
            <>
              <section className="timer-card">
                <div className="timer-top">
                  <span className="eyebrow">
                    {timer ? "TIMER RUNNING" : "READY WHEN YOU ARE"}
                  </span>
                  <span className="timer-label">
                    <span className={"dot " + (timer ? "live" : "")} />
                    {timer ? "Tracking time" : "No timer running"}
                  </span>
                </div>
                <TimerPanel
                  timer={timer}
                  active={active}
                  now={now}
                  busy={busy}
                  run={run}
                />
                <div className="timer-foot">
                  <span>
                    <Check size={15} />
                    Time survives locking and refreshing
                  </span>
                  <button onClick={() => setModal({ kind: "entry" })}>
                    <Plus size={16} /> Add time manually
                  </button>
                </div>
              </section>
              <section className="stats">
                <div>
                  <span>Tracked today</span>
                  <strong>{duration(todayDuration)}</strong>
                  <small>
                    {today.length} completed{" "}
                    {today.length === 1 ? "entry" : "entries"}
                  </small>
                </div>
                <div>
                  <span>Ready to invoice</span>
                  <strong>
                    {money(
                      unbilled.reduce((sum, e) => sum + amount(e), 0),
                      currency,
                    )}
                  </strong>
                  <button
                    onClick={() => {
                      setTab("Time");
                      setFilter("unbilled");
                    }}
                  >
                    Review {unbilled.length} entries <ArrowUpRight size={14} />
                  </button>
                </div>
                <div>
                  <span>Outstanding</span>
                  <strong>{money(outstanding, currency)}</strong>
                  <button onClick={() => setTab("Invoices")}>
                    {s.invoices.filter((i) => balance(i) > 0).length} unpaid
                    invoices <ArrowUpRight size={14} />
                  </button>
                </div>
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>Today’s work</h2>
                  <button
                    onClick={() => {
                      setTab("Time");
                      setFilter("all");
                    }}
                  >
                    View all time <ArrowUpRight size={16} />
                  </button>
                </div>
                {today.length ? (
                  entryRows(today.slice().reverse())
                ) : (
                  <Empty
                    icon={<Clock3 />}
                    title="Your day is a fresh page."
                    text="Start a timer or add time manually. Your completed work will appear here."
                    action="Add time"
                    onClick={() => setModal({ kind: "entry" })}
                  />
                )}
              </section>
              <div className="gentle-note">
                <Leaf size={18} />
                <span>Less admin. More room for the work you love.</span>
              </div>
            </>
          )}
          {tab === "Clients" && (
            <>
              <label className="search-label">
                Find a client
                <input
                  placeholder="Search name, contact or email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="client-grid">
                {s.clients
                  .filter((c) =>
                    (c.name + " " + c.contact + " " + c.email)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((c) => (
                    <button
                      className="client-card"
                      key={c.id}
                      onClick={() => setModal({ kind: "client", client: c })}
                    >
                      <div className="client-top">
                        <div className="avatar large">
                          {c.name.slice(0, 2).toUpperCase()}
                        </div>
                        <ChevronRight size={18} />
                      </div>
                      <h2>{c.name}</h2>
                      <p>{c.contact || c.email || "Add contact details"}</p>
                      <div className="client-footer">
                        <span>{money(c.rate, currency)} / hr</span>
                        <small>
                          {c.archived
                            ? "Archived"
                            : `${s.entries.filter((e) => e.client_id === c.id).length} entries`}
                        </small>
                      </div>
                    </button>
                  ))}
              </div>
              {!s.clients.length && (
                <div className="card">
                  <Empty
                    icon={<Users />}
                    title="Meet your first client."
                    text="Keep contact details, billing addresses and rates together."
                    action="Add client"
                    onClick={() => setModal({ kind: "client" })}
                  />
                </div>
              )}
            </>
          )}
          {tab === "Time" && (
            <>
              <div className="filters">
                {["unbilled", "all", "billed", "nonbillable"].map((f) => (
                  <button
                    key={f}
                    className={filter === f ? "chosen" : ""}
                    onClick={() => {
                      setFilter(f);
                      setSelected([]);
                    }}
                  >
                    {f === "unbilled"
                      ? "Unbilled"
                      : f === "all"
                        ? "All time"
                        : f === "billed"
                          ? "Invoiced"
                          : "Nonbillable"}
                  </button>
                ))}
              </div>
              <div className="card">
                {entryRows(
                  s.entries
                    .filter(
                      (e) =>
                        filter === "all" ||
                        (filter === "unbilled" &&
                          e.billable &&
                          !e.invoice_id) ||
                        (filter === "billed" && !!e.invoice_id) ||
                        (filter === "nonbillable" && !e.billable),
                    )
                    .slice()
                    .reverse(),
                  true,
                )}
                {!s.entries.some(
                  (e) =>
                    filter === "all" ||
                    (filter === "unbilled" && e.billable && !e.invoice_id) ||
                    (filter === "billed" && !!e.invoice_id) ||
                    (filter === "nonbillable" && !e.billable),
                ) && (
                  <Empty
                    icon={<Rows3 />}
                    title="Nothing here just yet."
                    text="Add time or choose another view to review your work."
                    action="Add time"
                    onClick={() => setModal({ kind: "entry" })}
                  />
                )}
              </div>
              {selected.length > 0 && (
                <div className="selection-bar">
                  <div>
                    <strong>{selected.length} selected</strong>
                    <span>
                      {money(
                        s.entries
                          .filter((e) => selected.includes(e.id))
                          .reduce((sum, e) => sum + amount(e), 0),
                        currency,
                      )}
                    </span>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || offline || !!cache.queue.length}
                    onClick={() => setModal({ kind: "invoice" })}
                  >
                    Create invoice <ArrowUpRight size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Clear selection"
                    onClick={() => setSelected([])}
                  >
                    <X size={18} />
                  </button>
                </div>
              )}
            </>
          )}
          {tab === "Invoices" && (
            <>
              <div className="invoice-summary">
                <span>Awaiting payment</span>
                <strong>{money(outstanding, currency)}</strong>
                <small>
                  {s.invoices.filter((i) => balance(i) > 0).length} open
                  invoices
                </small>
              </div>
              <section className="card">
                {s.invoices
                  .slice()
                  .reverse()
                  .map((i) => (
                    <button
                      key={i.id}
                      className="invoice-row"
                      onClick={() => setModal({ kind: "detail", invoice: i })}
                    >
                      <div className="avatar">
                        <FileText size={21} />
                      </div>
                      <div className="row-main">
                        <strong>{i.client.name}</strong>
                        <span>
                          {i.number} · Due {i.due}
                        </span>
                      </div>
                      <div className="row-value">
                        <strong>{money(balance(i), i.issuer.currency)}</strong>
                        <span
                          className={
                            "badge " +
                            (balance(i) === 0
                              ? "paid"
                              : i.due < localDate(now)
                                ? "overdue"
                                : "")
                          }
                        >
                          {i.voided
                            ? "Void"
                            : balance(i) === 0
                              ? "Paid"
                              : i.due < localDate(now)
                                ? "Overdue"
                                : balance(i) < i.total
                                  ? "Part paid"
                                  : "Awaiting payment"}
                        </span>
                      </div>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                {!s.invoices.length && (
                  <Empty
                    icon={<FileText />}
                    title="Turn your time into an invoice."
                    text="Select billable entries in Time, then finalize an invoice and download its PDF."
                    action="Review time"
                    onClick={() => {
                      setTab("Time");
                      setFilter("unbilled");
                    }}
                  />
                )}
              </section>
            </>
          )}
          <footer>
            TIME LEDGER <span>Made for independent work.</span>
          </footer>
        </div>
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className="modal"
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="close icon-button"
              aria-label="Close dialog"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            <ModalContent
              key={
                modal.kind +
                ("entry" in modal
                  ? modal.entry?.id
                  : "client" in modal
                    ? modal.client?.id
                    : "invoice" in modal
                      ? modal.invoice.id
                      : "")
              }
              modal={modal}
              s={s}
              version={(cache.snapshot?.version ?? 0) + cache.queue.length}
              selected={selected}
              busy={busy}
              offline={offline || !!cache.queue.length}
              mutate={mutate}
              close={() => setModal(null)}
              download={download}
              logout={logout}
              openRestore={() => setModal({ kind: "restore" })}
              correct={(e) => setModal({ kind: "entry", correction: e })}
              onInvoice={() => {
                setSelected([]);
                setTab("Invoices");
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator && import.meta.env?.PROD)
  window.addEventListener(
    "load",
    () => void navigator.serviceWorker.register("/sw.js"),
  );
