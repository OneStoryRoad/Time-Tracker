# Time Ledger

Private, single-owner time tracking and invoices. Canonical project: **OneStoryRoad/Time-Tracker**. Built for an iPhone browser and compatible with desktop. This checkpoint is a workspace application, not a deployed production service.

## Run a synthetic local preview

Requires Python 3.12+, Node 22.12+ (validated here with Node 24.19), and npm. No cloud account or paid service is required.

```bash
cd /workspace/Time-Tracker
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-lock.txt
npm ci --cache /tmp/time-ledger-npm
npm run build
APP_TEST_MODE=1 APP_DB=/tmp/time-ledger-preview.sqlite python -m server.app
```

Open **http://127.0.0.1:8000**. The fixed **synthetic-only** local preview password is `synthetic-preview-only`. Test mode binds to loopback and rejects login from non-loopback clients. Do not use test mode for hosting or real data. Stop with Ctrl-C. Default production startup refuses to run until private HTTPS origin and an owner password hash are configured.

`npm run dev` runs an optional Vite development frontend at http://127.0.0.1:5173 with the API proxied to port 8000. Service-worker/offline tests use the production build served by Python, not Vite.

## Use

- **Today:** choose a client, add a note, start/stop a timer, or switch clients atomically. Timers save start timestamps and rates; they do not depend on a background browser interval. Review unusually long timers after interruptions.
- **Clients:** name, contact, email, billing address, default rate, archive. Rate changes apply to future work. History stays intact.
- **Time:** add/edit manual time, billable flag, notes, historical saved rate. Review unbilled, invoiced, or nonbillable time. Select entries for a single client to invoice.
- **Invoices:** review and finalize, assign consecutive numbers and due dates, download a PDF, record partial/manual payments, review balances and linked entries. Downloads are owner-authenticated. Nothing is sent, charged, or transferred.
- **Settings & backups:** business identity, currency and payment instructions, complete JSON backup, CSV time export, explicitly confirmed replacement restore. Currency is fixed once time exists.

Finalized invoices snapshot client/issuer details, rates, notes, durations and totals. Linked entries cannot be edited or deleted. To correct an unpaid invoice, **void it with a reason**, open its linked time, and use **Correct time** to create a linked replacement. The voided document and locked original time remain in history; each original entry permits one direct correction, which can be invoiced under a new number. For a paid invoice, correct/remove erroneous payment records first; genuine refunds/credits require a separate agreed process outside this small app. Removing a payment only corrects the record and never moves money. No tax, payroll, bank feeds or bookkeeping engine are included.

## Data and precision

SQLite is the authoritative ledger. Mutations and request receipts commit together under `BEGIN IMMEDIATE`, with WAL and `synchronous=FULL`; version checks reject stale writes. A command UUID can be replayed after a lost response without performing the action again. Invoice entry links and payment totals are validated within the same transaction. Receipts contain compact metadata, not copies of the entire ledger.

Money and rates are integer cents. Timestamps and durations are integer milliseconds. Each line is calculated as `floor((duration_ms × hourly_rate_cents + 1,800,000) / 3,600,000)` — nearest cent, ties up. The invoice is the sum of rounded lines. Python integer arithmetic and browser `BigInt` avoid floating-point billing. Currency display and PDF hours are presentation only. Zero-rate/free lines are allowed. Positive payments cannot exceed the remaining balance. Amounts are limited to 100,000,000 cents ($1 million in USD), durations to 365 days, and timestamps to years 2000–2099. Manual inputs preserve milliseconds; times are shown in the device timezone and PDF line dates are explicitly UTC. Today totals clip work to the current local day, including work across midnight.

## Offline and interruptions

After one successful online load and service-worker installation, the application shell and last authorized ledger can open offline. IndexedDB atomically stores the confirmed snapshot plus an outbox. Timers, notes and manual time can queue offline; each action keeps its original timestamp and request ID. Client/settings edits, invoice finalization, payments, downloads and restore require connectivity and a synced outbox.

Offline changes display **saved on this device**, not server-synced. Keep browser storage until sync succeeds. Closing/locking the phone or refreshing does not stop an existing timer. Reconnection/focus triggers a retry. A rejected or stale queued action remains recoverable with an error; export the pending action JSON before explicitly discarding it, sync the current server ledger, then re-enter the intended change. Automatic rebasing is avoided for financial changes. Failed online saves never report server success. Duplicate clicks are guarded; same-browser tabs coordinate through Web Locks and IndexedDB, and all devices still pass server version and domain checks. Cross-tab logout clears displays via BroadcastChannel.

The cached ledger is not encrypted with an app password. Offline access assumes an authorized, device-locked browser profile; it is not fresh offline authentication. Sign out while online to revoke the session and clear the ledger cache across tabs. Pending actions must be synced or exported/discarded before logout. The service worker caches only public application resources, never API responses, passwords, PDFs or backups. Browser/site-data deletion or device loss can destroy unsynced actions. Production sessions expire after 12 hours and also expire on server restart; sign in again to sync retained actions.

## Backup and recovery

Stop the timer and sync. Download a full backup from Settings, and keep it privately. The JSON includes versioned format, a SHA-256 checksum of canonical state, clients, entries, timer-free state, original invoice snapshots/numbers, correction links, settings and payment history. It excludes passwords, sessions and command receipts. The checksum detects accidental alteration, not malicious tampering by someone who can recompute it.

For a clean restore: start a separate empty instance with a new `APP_DB`, sign in, select the backup in Settings → Restore, review counts and type **REPLACE**. All relationships, uniqueness, totals, dates and checksum are checked before the atomic replacement; invalid backups leave the previous version intact. Restoration advances the receiving ledger version and preserves the next invoice number. Keep a current backup before replacing an existing ledger. Stop timers first; running-timer backups/restores are intentionally blocked. CSV is a convenient time export, not a complete restore format.

For server-level backups use SQLite’s online backup API or stop the process before copying database/WAL files. Do not copy only a live WAL-mode `.sqlite` file. Store the database on persistent local storage; ephemeral filesystem hosts are unsuitable. Test recovery on a separate database regularly.

## Verify

```bash
source .venv/bin/activate
npm run typecheck
npm run lint
npm test
npm run build
# In one terminal; browser tests deliberately replace ONLY this synthetic DB:
APP_TEST_MODE=1 APP_DB=/tmp/time-ledger-browser.sqlite python -m server.app
# In a second terminal:
npm run test:browser
```

Browser tests use system Chromium (`/usr/bin/chromium`) on this environment. Configure `playwright.config.ts` for another local executable if necessary. Do not point tests at a live ledger. Evidence and known gaps: [docs/REVIEW.md](docs/REVIEW.md). Architecture/invariants: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Private setup/approval boundaries: [docs/HOSTING.md](docs/HOSTING.md).
