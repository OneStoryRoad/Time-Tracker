import React, { useState, useEffect, useRef } from "react";
import { Clock3, ArrowUpRight, Plus, Play, Square } from "lucide-react";
import { duration } from "./types";
import type { Client, State } from "./types";
export function Login({
  error,
  notice,
  onLogin,
}: {
  error: string;
  notice: string;
  onLogin: (p: string) => Promise<void>;
}) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand-mark">
          <Clock3 size={27} />
        </div>
        <div className="eyebrow">YOUR PRIVATE WORKSPACE</div>
        <h1>Time Ledger</h1>
        <p>
          A little less admin.
          <br />A little more headspace.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void onLogin(password).finally(() => setBusy(false));
          }}
        >
          <label>
            Owner password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Opening…" : "Open your ledger"} <ArrowUpRight size={18} />
          </button>
        </form>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {notice && <p>{notice}</p>}
        <small>Private access · No payment processor</small>
      </div>
    </div>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      <button className="secondary" onClick={onClick}>
        {action}
        <Plus size={16} />
      </button>
    </div>
  );
}
export function TimerPanel({
  timer,
  active,
  now,
  busy,
  run,
}: {
  timer: State["timer"];
  active: Client[];
  now: number;
  busy: boolean;
  run: (k: string, p: Record<string, unknown>) => void;
}) {
  const [client, setClient] = useState(active[0]?.id ?? ""),
    [notes, setNotes] = useState(""),
    [billable, setBillable] = useState(true);
  const [runningNote, setRunningNote] = useState(timer?.notes ?? "");
  useEffect(
    () => setRunningNote(timer?.notes ?? ""),
    [timer?.id, timer?.notes],
  );
  const chosen = active.some((c) => c.id === client)
    ? client
    : (active[0]?.id ?? "");
  return (
    <>
      <div className="clock-display" aria-live="off">
        {duration(timer ? now - timer.start : 0)}
        <span>
          {timer
            ? "Stay in your flow. We’ll keep the time."
            : "Start something good."}
        </span>
      </div>
      {timer ? (
        <>
          <strong className="running-client">
            {active.find((c) => c.id === timer.client_id)?.name ??
              "Archived client"}
          </strong>
          <p className="running-notes">
            {timer.notes || "No note"} ·{" "}
            {timer.billable ? "Billable" : "Nonbillable"}
          </p>
          <div className="timer-controls">
            <select
              aria-label="Switch timer client"
              value={chosen}
              onChange={(e) => setClient(e.target.value)}
            >
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="secondary"
              disabled={busy || !chosen || chosen === timer.client_id}
              onClick={() =>
                run("switch", {
                  timer_id: timer.id,
                  stop_notes: runningNote,
                  client_id: chosen,
                  at: Date.now(),
                  notes: "",
                  billable: true,
                })
              }
            >
              Switch client
            </button>
            <button
              className="stop"
              disabled={busy}
              onClick={() =>
                run("stop", {
                  timer_id: timer.id,
                  stop_notes: runningNote,
                  at: Date.now(),
                })
              }
            >
              <Square size={16} fill="currentColor" /> Stop timer
            </button>
          </div>
          <label className="timer-note-edit">
            Update running note
            <input
              value={runningNote}
              maxLength={4000}
              onChange={(e) => setRunningNote(e.target.value)}
              placeholder="What are you working on?"
            />
          </label>
          {runningNote !== timer.notes && (
            <button
              className="save-note"
              disabled={busy}
              onClick={() =>
                run("timer_notes", { timer_id: timer.id, notes: runningNote })
              }
            >
              Save note (also saved when stopping)
            </button>
          )}
          {now < timer.start && (
            <div className="timer-warning">
              Your device clock is before the saved start time. Correct the
              clock before stopping.
            </div>
          )}
          {now - timer.start > 12 * 3600000 && (
            <div className="timer-warning">
              This timer has been running over 12 hours. Stop it, then review
              and adjust the saved time if needed.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="timer-controls">
            <select
              aria-label="Timer client"
              value={chosen}
              onChange={(e) => setClient(e.target.value)}
            >
              <option value="" disabled>
                Choose a client
              </option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="start"
              disabled={busy || !chosen}
              onClick={() =>
                run("start", {
                  client_id: chosen,
                  at: Date.now(),
                  notes,
                  billable,
                })
              }
            >
              <Play size={17} fill="currentColor" /> Start timer
            </button>
          </div>
          <input
            className="note-input"
            aria-label="Timer note"
            maxLength={4000}
            placeholder="What are you working on? (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
            />{" "}
            Billable time
          </label>
          {!active.length && (
            <p className="timer-warning">
              Add a client in Clients to start tracking.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function useDialogFocus(
  open: boolean,
  container: React.RefObject<HTMLElement | null>,
  close: () => void,
  busy: React.RefObject<boolean>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || !container.current) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = container.current;
    const controls = () =>
      [
        ...root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href]',
        ),
      ].filter((el) => el.getClientRects().length > 0);
    (
      root.querySelector<HTMLElement>(
        'input:not([type="hidden"]),select,textarea',
      ) ??
      controls()[0] ??
      root
    ).focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy.current) {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const all = controls(),
          first = all[0],
          last = all.at(-1);
        if (!first) {
          e.preventDefault();
          root.focus();
        } else if (
          e.shiftKey &&
          (document.activeElement === first ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, container, busy]);
}
