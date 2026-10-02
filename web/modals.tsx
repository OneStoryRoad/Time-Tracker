import { useState, useRef } from "react";
import { Check, Download, LogOut } from "lucide-react";
import type { Modal } from "./ui-types";
import type { Client, Entry, Invoice, State } from "./types";
import { cents, localInput, localDate, amount, money, duration } from "./types";
import { readCache } from "./store";
type ModalProps = {
  modal: NonNullable<Modal>;
  s: State;
  version: number;
  selected: string[];
  busy: boolean;
  offline: boolean;
  mutate: (k: string, p: Record<string, unknown>) => Promise<boolean>;
  close: () => void;
  download: (p: string) => Promise<void>;
  logout: () => Promise<void>;
  openRestore: () => void;
  correct: (e: Entry) => void;
  onInvoice: () => void;
};
export function ModalContent(props: ModalProps) {
  const { modal } = props;
  if (modal.kind === "client")
    return <ClientForm {...props} client={modal.client} />;
  if (modal.kind === "entry")
    return (
      <EntryForm {...props} entry={modal.entry} correction={modal.correction} />
    );
  if (modal.kind === "settings") return <SettingsForm {...props} />;
  if (modal.kind === "invoice") return <InvoiceForm {...props} />;
  if (modal.kind === "detail")
    return <InvoiceDetail {...props} invoice={modal.invoice} />;
  return <RestoreForm {...props} />;
}
function useFormAction(props: ModalProps) {
  const version = useRef(props.version);
  const [err, setErr] = useState("");
  return {
    err,
    submit: async (k: string, p: Record<string, unknown>, close = true) => {
      setErr("");
      try {
        if (version.current !== props.version)
          throw Error(
            "The ledger changed while this form was open. Close and reopen it to review current data.",
          );
        await props.mutate(k, p);
        const c = await readCache();
        version.current = (c.snapshot?.version ?? 0) + c.queue.length;
        if (close) props.close();
        return true;
      } catch (e) {
        setErr((e as Error).message);
        return false;
      }
    },
    setErr,
  };
}
function ClientForm(props: ModalProps & { client?: Client }) {
  const { client, busy } = props,
    { err, submit, setErr } = useFormAction(props);
  return (
    <>
      <h2 id="modal-title">{client ? "Edit client" : "Add a client"}</h2>
      <p className="subtle">
        New rates apply to future work. Existing time keeps its rate.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            void submit("client", {
              ...(client ? { id: client.id } : {}),
              name: String(f.get("name")).trim(),
              contact: f.get("contact"),
              email: f.get("email"),
              address: f.get("address"),
              rate: cents(String(f.get("rate"))),
              archived: f.get("archived") === "on",
            });
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <label>
          Client name
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={client?.name}
          />
        </label>
        <label>
          Contact name
          <input
            name="contact"
            maxLength={4000}
            defaultValue={client?.contact}
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={client?.email}
          />
        </label>
        <label>
          Billing address
          <textarea
            name="address"
            rows={3}
            maxLength={4000}
            defaultValue={client?.address}
          />
        </label>
        <label>
          Default hourly rate ({props.s.settings.currency})
          <input
            name="rate"
            inputMode="decimal"
            required
            defaultValue={((client?.rate ?? 0) / 100).toFixed(2)}
          />
        </label>
        {client && (
          <label className="check-label">
            <input
              name="archived"
              type="checkbox"
              defaultChecked={client.archived}
            />{" "}
            Archive client (preserves history)
          </label>
        )}
        <FormError message={err} />
        <button className="primary full" disabled={busy || props.offline}>
          Save client <Check size={17} />
        </button>
      </form>
    </>
  );
}
function EntryForm(props: ModalProps & { entry?: Entry; correction?: Entry }) {
  const entrySource = props.entry ?? props.correction;
  const { s, busy } = props;
  const entry = props.entry;
  const { err, submit, setErr } = useFormAction(props),
    locked = !!entry?.invoice_id;
  return (
    <>
      <h2 id="modal-title">
        {props.correction
          ? "Correct voided time"
          : entry
            ? "Time entry"
            : "Add time"}
      </h2>
      <p className="subtle">
        Dates and times use your device’s timezone. Rates are saved with each
        entry.
      </p>
      {locked && (
        <p className="notice">
          Finalized on{" "}
          {s.invoices.find((i) => i.id === entry.invoice_id)?.number}. This time
          is locked.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            const start = new Date(String(f.get("start"))).getTime(),
              end = new Date(String(f.get("end"))).getTime();
            if (
              !Number.isFinite(start) ||
              !Number.isFinite(end) ||
              end <= start
            )
              throw Error("End time must be after start time.");
            void submit("entry", {
              ...(entry ? { id: entry.id } : {}),
              ...(props.correction
                ? { correction_of: props.correction.id }
                : {}),
              client_id: f.get("client_id"),
              start,
              end,
              notes: f.get("notes"),
              billable: f.get("billable") === "on",
              ...(entrySource ? { rate: cents(String(f.get("rate"))) } : {}),
            });
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        <fieldset disabled={locked}>
          <label>
            Client
            <select
              name="client_id"
              defaultValue={
                entrySource?.client_id ?? s.clients.find((c) => !c.archived)?.id
              }
              required
            >
              {s.clients
                .filter((c) => !c.archived || c.id === entrySource?.client_id)
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Start
            <input
              type="datetime-local"
              step="0.001"
              name="start"
              required
              defaultValue={localInput(
                entrySource?.start ?? Date.now() - 3600000,
              )}
            />
          </label>
          <label>
            End
            <input
              type="datetime-local"
              step="0.001"
              name="end"
              required
              defaultValue={localInput(entrySource?.end ?? Date.now())}
            />
          </label>
          <label>
            Work notes
            <textarea
              name="notes"
              maxLength={4000}
              rows={3}
              defaultValue={entrySource?.notes}
            />
          </label>
          {entrySource && (
            <label>
              Saved hourly rate ({s.settings.currency})
              <input
                name="rate"
                inputMode="decimal"
                defaultValue={(entrySource!.rate / 100).toFixed(2)}
              />
            </label>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              name="billable"
              defaultChecked={entrySource?.billable ?? true}
            />{" "}
            Billable time
          </label>
        </fieldset>
        <FormError message={err} />
        {!locked && (
          <button className="primary full" disabled={busy || !s.clients.length}>
            Save time <Check size={17} />
          </button>
        )}
      </form>
      {entry && !locked && (
        <button
          className="text-button danger"
          disabled={busy || props.offline}
          onClick={() => {
            if (confirm("Delete this unbilled time entry?"))
              void submit("delete_entry", { id: entry.id });
          }}
        >
          Delete entry
        </button>
      )}
      {locked && (
        <button
          className="secondary full"
          onClick={() =>
            void props.download(`invoices/${entry.invoice_id}/pdf`)
          }
        >
          Download linked invoice <Download size={17} />
        </button>
      )}
    </>
  );
}
function SettingsForm(props: ModalProps) {
  const { s, busy, offline } = props,
    { err, submit } = useFormAction(props);
  return (
    <>
      <h2 id="modal-title">Settings & backups</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void submit("settings", Object.fromEntries(f));
        }}
      >
        <label>
          Your business name
          <input
            name="business"
            required
            maxLength={120}
            defaultValue={s.settings.business}
          />
        </label>
        <label>
          Business address
          <textarea
            name="address"
            rows={2}
            maxLength={4000}
            defaultValue={s.settings.address}
          />
        </label>
        <label>
          Business email
          <input
            name="email"
            type="email"
            maxLength={254}
            defaultValue={s.settings.email}
          />
        </label>
        <label>
          Currency
          <select
            name="currency"
            defaultValue={s.settings.currency}
            disabled={s.entries.length > 0 || !!s.timer}
          >
            {["USD", "CAD", "GBP", "EUR", "AUD"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          {(s.entries.length > 0 || s.timer) && (
            <>
              <input
                type="hidden"
                name="currency"
                value={s.settings.currency}
              />
              <small>Currency is fixed once work is recorded.</small>
            </>
          )}
        </label>
        <label>
          Invoice payment instructions
          <textarea
            name="terms"
            rows={3}
            maxLength={4000}
            defaultValue={s.settings.terms}
          />
        </label>
        <FormError message={err} />
        <button className="primary full" disabled={busy || offline}>
          Save settings
        </button>
      </form>
      <hr />
      <h3>Your data, in your hands.</h3>
      <p className="subtle">
        Backups include clients, time, invoice snapshots and payments. Stop your
        timer and sync first. Keep backups in a private location.
      </p>
      <div className="backup-buttons">
        <button
          className="secondary"
          disabled={offline || !!s.timer}
          onClick={() => void props.download("backup")}
        >
          <Download size={16} /> Download backup
        </button>
        <button
          className="secondary"
          disabled={offline}
          onClick={() => void props.download("export")}
        >
          Export time CSV
        </button>
        <button
          className="text-button danger"
          disabled={offline || !!s.timer}
          onClick={props.openRestore}
        >
          Restore a backup
        </button>
      </div>
      <p className="subtle">
        iPhone: open in Safari, use Share → Add to Home Screen. This browser
        stores a device copy for offline work. Signing out clears the ledger
        cache; protect the device with its lock.
      </p>
      <button
        className="secondary full"
        disabled={busy || offline}
        onClick={() => void props.logout()}
      >
        <LogOut size={17} /> Sign out & clear device cache
      </button>
    </>
  );
}
function InvoiceForm(props: ModalProps) {
  const { s, selected, busy } = props,
    { err, submit } = useFormAction(props),
    entries = s.entries.filter((e) => selected.includes(e.id)),
    same = new Set(entries.map((e) => e.client_id)).size === 1,
    total = entries.reduce((sum, e) => sum + amount(e), 0);
  const due = new Date();
  due.setDate(due.getDate() + 30);
  return (
    <>
      <h2 id="modal-title">Review your invoice</h2>
      <p className="subtle">
        Finalizing assigns a number and locks these entries. Download the PDF to
        share it yourself.
      </p>
      {!same && (
        <p className="form-error">Select entries for one client at a time.</p>
      )}
      <div className="invoice-preview">
        <span>
          {s.clients.find((c) => c.id === entries[0]?.client_id)?.name}
        </span>
        <strong>{money(total, s.settings.currency)}</strong>
        <small>
          {entries.length} entries ·{" "}
          {duration(entries.reduce((sum, e) => sum + e.end - e.start, 0))}
        </small>
      </div>
      <div className="review-lines">
        {entries.map((e) => (
          <div key={e.id}>
            <span>
              {e.notes || "Professional services"}
              <small>
                {new Date(e.start).toLocaleString()} ·{" "}
                {duration(e.end - e.start)} @{" "}
                {money(e.rate, s.settings.currency)}/hr
              </small>
            </span>
            <strong>{money(amount(e), s.settings.currency)}</strong>
          </div>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (
            await submit("invoice", {
              entry_ids: selected,
              issued: f.get("issued"),
              due: f.get("due"),
            })
          )
            props.onInvoice();
        }}
      >
        <label>
          Issue date
          <input
            name="issued"
            type="date"
            required
            defaultValue={localDate()}
          />
        </label>
        <label>
          Due date
          <input
            name="due"
            type="date"
            required
            defaultValue={localDate(due.getTime())}
          />
        </label>
        <FormError message={err} />
        <button
          className="primary full"
          disabled={busy || props.offline || !same || !entries.length}
        >
          Finalize invoice <Check size={18} />
        </button>
      </form>
    </>
  );
}
function InvoiceDetail(props: ModalProps & { invoice: Invoice }) {
  const i =
      props.s.invoices.find((x) => x.id === props.invoice.id) ?? props.invoice,
    payments = props.s.payments.filter((p) => p.invoice_id === i.id),
    paid = payments.reduce((sum, p) => sum + p.amount, 0),
    balance = i.voided ? 0 : i.total - paid,
    { err, submit, setErr } = useFormAction(props);
  return (
    <>
      <div className="eyebrow">FINALIZED INVOICE</div>
      <h2 id="modal-title">{i.number}</h2>
      {i.voided && (
        <p className="notice">
          Void · {i.void_date} · {i.void_reason}
        </p>
      )}
      <p className="subtle">
        {i.client.name} · Issued {i.issued} · Due {i.due}
      </p>
      <div className="invoice-preview">
        <span>Balance due</span>
        <strong>{money(balance, i.issuer.currency)}</strong>
        <small>
          Total {money(i.total, i.issuer.currency)} · Paid{" "}
          {money(paid, i.issuer.currency)}
        </small>
      </div>
      <button
        className="primary full"
        disabled={props.offline}
        onClick={() => void props.download(`invoices/${i.id}/pdf`)}
      >
        <Download size={18} /> Download invoice PDF
      </button>
      <h3 className="space-top">Linked time</h3>
      <div className="review-lines">
        {i.lines.map((l) => (
          <div key={l.entry_id}>
            <span>
              {l.notes || "Professional services"}
              <small>
                {new Date(l.start).toLocaleString()} ·{" "}
                {duration(l.end - l.start)}
              </small>
              <small className="entry-link">Entry {l.entry_id}</small>
            </span>
            <strong>{money(l.amount, i.issuer.currency)}</strong>
            {i.voided &&
              !props.s.entries.some((e) => e.correction_of === l.entry_id) && (
                <button
                  className="text-button"
                  onClick={() =>
                    props.correct(
                      props.s.entries.find((e) => e.id === l.entry_id)!,
                    )
                  }
                >
                  Correct time
                </button>
              )}
          </div>
        ))}
      </div>
      <h3 className="space-top">Payments</h3>
      {payments.map((p) => (
        <div className="payment-row" key={p.id}>
          <div>
            <strong>{money(p.amount, i.issuer.currency)}</strong>
            <small>
              {p.date} · {p.reference || "Manual payment"}
            </small>
          </div>
          <button
            className="text-button danger"
            disabled={props.busy || props.offline}
            onClick={() => {
              if (
                confirm(
                  "Remove this payment record? This changes the balance; it does not move money.",
                )
              )
                void submit("delete_payment", { id: p.id }, false);
            }}
          >
            Remove
          </button>
        </div>
      ))}
      {!payments.length && <p className="subtle">No payments recorded yet.</p>}
      {!i.voided && !payments.length && (
        <button
          className="text-button danger"
          disabled={props.busy || props.offline}
          onClick={() => {
            const reason = prompt(
              "Why are you voiding this invoice? The original stays in history. Linked time stays locked; create corrected time from the voided invoice.",
            );
            if (reason?.trim())
              void submit(
                "void_invoice",
                { id: i.id, reason: reason.trim(), date: localDate() },
                false,
              );
          }}
        >
          Void invoice
        </button>
      )}
      {balance > 0 && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            try {
              const form = e.currentTarget;
              if (
                await submit(
                  "payment",
                  {
                    invoice_id: i.id,
                    amount: cents(String(f.get("amount"))),
                    date: f.get("date"),
                    reference: f.get("reference"),
                  },
                  false,
                )
              )
                form.reset();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          <p className="subtle">
            Record money you’ve already received. This does not charge or
            transfer funds.
          </p>
          <label>
            Payment amount ({i.issuer.currency})
            <input
              name="amount"
              inputMode="decimal"
              required
              placeholder={(balance / 100).toFixed(2)}
            />
          </label>
          <label>
            Payment date
            <input
              name="date"
              type="date"
              required
              defaultValue={localDate()}
            />
          </label>
          <label>
            Reference / method
            <input
              name="reference"
              maxLength={4000}
              placeholder="Check, cash, transfer…"
            />
          </label>
          <button
            className="secondary full"
            disabled={props.busy || props.offline}
          >
            Record payment <Check size={17} />
          </button>
        </form>
      )}
      <FormError message={err} />
    </>
  );
}
function RestoreForm(props: ModalProps) {
  const [backup, setBackup] = useState<{ format: string; state: State } | null>(
      null,
    ),
    [text, setText] = useState(""),
    { err, submit, setErr } = useFormAction(props);
  return (
    <>
      <h2 id="modal-title">Restore a backup</h2>
      <p className="subtle">
        This replaces the whole ledger. Download a current backup first. Invalid
        files are rejected without changing any data.
      </p>
      <label>
        Backup JSON file
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            setBackup(null);
            setErr("");
            try {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 20 * 1024 * 1024) throw Error("File exceeds 20 MB.");
              const b = JSON.parse(await f.text());
              if (
                b.format !== "time-ledger-backup-v1" ||
                !Array.isArray(b.state?.clients)
              )
                throw Error("Unsupported backup file.");
              setBackup(b);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        />
      </label>
      {backup && (
        <>
          <div className="notice">
            {backup.state.clients.length} clients ·{" "}
            {backup.state.entries.length} time entries ·{" "}
            {backup.state.invoices.length} invoices ·{" "}
            {backup.state.payments.length} payments
          </div>
          <label>
            Type REPLACE to confirm
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="stop full"
            disabled={text !== "REPLACE" || props.busy || props.offline}
            onClick={() => void submit("restore", { backup })}
          >
            Replace ledger with backup
          </button>
        </>
      )}
      <FormError message={err} />
    </>
  );
}
function FormError({ message }: { message: string }) {
  return message ? (
    <p className="form-error" role="alert">
      {message}
    </p>
  ) : null;
}
