# Architecture and review map

| Area | Files | Responsibility |
| --- | --- | --- |
| Ledger domain | `server/domain.py` | Strict schema, integer money/time, commands, snapshot integrity, uniqueness, void/correction relationships |
| API and persistence | `server/app.py` | Owner cookie authentication, same-origin checks, SQLite transactions, versions and request receipts, downloads, static production build |
| PDF | `server/pdf.py`, `server/fonts/` | Escaped text, embedded licensed Unicode font, repeatable paginated table, frozen identity/work/totals, current payment balance and void status |
| Main interface | `web/main.tsx` | Navigation, views, mutation/sync coordination, cross-tab broadcasts, dialogs |
| Forms | `web/modals.tsx` | Client/time/settings/invoice/payment/restore workflows, stale-form checks |
| Timer and shared views | `web/components.tsx` | Timer controls, login and empty states |
| Device persistence | `web/store.ts` | Atomic IndexedDB snapshot/outbox, API error handling, pending projection |
| Precision and types | `web/types.ts`, `web/ui-types.ts` | Typed records, exact BigInt line calculations, local dates/millisecond editing |
| Installation and offline shell | `public/sw.js`, `public/manifest.webmanifest`, icons | App-shell cache; public resources only; Home Screen metadata |
| Tests | `tests/test_ledger.py`, `tests/browser/app.spec.ts` | Synthetic backend and browser acceptance checks |

## Write path

A foreground mutation obtains a browser Web Lock, reads the shared IndexedDB cache, compares it with the view version, persists a UUID command and any safe time projection atomically, and sends the command. The server opens `BEGIN IMMEDIATE`, checks receipt UUID/content hash before version checks, applies a pure domain command to copied state, validates all invariants, and commits ledger plus receipt together. The device persists the response before removing that outbox item. Pending timer/entry references are resolved using generated-ID metadata before dependent commands are sent. If the response was lost after server commit, replay retrieves the saved metadata and current state without repeating the mutation.

The server serializes writes even across separate browser profiles/devices. Every mutation requires the expected ledger revision. A stale command is retained for explicit recovery, not automatically converted into a new financial action. Forms retain their open revision and require reopening if other work changed the ledger. Submitted payment forms reset after confirmation, reducing accidental repeat submissions with unchanged fields. Intentional identical payments after a reviewed refresh are allowed.

## Invariants

- One timer; stop/switch transforms it into exactly one completed entry atomically. Timer rate is captured at start.
- Monetary/time fields reject floats, booleans, coercive strings and out-of-range values. End must exceed start; future event times are rejected (60-second clock tolerance).
- Each billable original time entry links to one finalized invoice line. Selection is nonempty, unique, same client, billable and unbilled. Line identity/rate/notes/timestamps/correction link match the locked entry.
- Issuer/client/work/rate/total snapshots remain unchanged after finalization. PDFs reflect those snapshots and separately show current recorded payments or void state.
- Invoice sequence is monotonically allocated during regular commands. Backup replacement preserves its own next number and validates it against every imported number.
- Payments are positive and sum to no more than invoice total. Voided invoices cannot accept payments. Paid invoices cannot be voided without first correcting payment records.
- Voiding retains original entry links/snapshots and number. A correction links a new entry to one original on a void invoice for the same client; duplicate direct corrections and correction cycles are rejected.
- Restore verifies canonical-state checksum, strict fields, IDs, dates, relationships, line calculations, totals, sequence, payment balances and stopped timers before replacement. Ledger version advances. Receipts remain on the receiving instance so an old retry cannot recreate an already acknowledged action.

## Operational limits

A validated JSON ledger in SQLite keeps implementation and recovery small. Each mutation validates the document; this is appropriate for a small independent-worker ledger, not high-volume multi-user accounting. Per-table limits and a 20 MB import cap bound accepted backup sizes. Long-term real workloads have not been load-tested. Sessions/throttling are intentionally single-process and ephemeral. A stopped-timer JSON backup is the portable recovery unit. An offline outbox is device-local and must be exported before browser storage deletion. Device copies and exported files rely on OS/storage privacy, not application encryption.
