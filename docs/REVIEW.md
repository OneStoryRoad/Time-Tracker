# Independent-review checkpoint

Canonical checkout: `/workspace/Time-Tracker`, origin `https://github.com/OneStoryRoad/Time-Tracker.git`. Source started from `57586e3` (initial license commit). Only this build was edited. No archived/stopped attempt or other task was touched. Requested Sol6.1High / normal Standard creation settings were acknowledged and left unchanged; runtime model/tier are not exposed to the workspace tools and were not independently verified.

## Actual final validation

| Check | Result | Evidence |
| --- | --- | --- |
| Python unit/integration | **36 passed**, 1 test-helper deprecation warning | `evidence/backend-results.txt` |
| Browser acceptance | **28 passed**: 14 desktop + 14 iPhone-sized Chromium | `evidence/browser-results.txt`, `tests/browser/app.spec.ts` |
| TypeScript strict check | Passed | `evidence/typecheck-results.txt` |
| ESLint and Ruff | Passed | `evidence/lint-results.txt` |
| Production interface build | Passed | `evidence/build-results.txt` |
| Unconfigured production startup | Refused with nonzero exit; requires owner hash and HTTPS origin | `server/app.py`, production-auth integration test |
| PDF inspection | Rendered and visually inspected unpaid, paid and long Unicode versions | `evidence/synthetic-invoice.png`, `evidence/synthetic-paid-invoice.png`, `evidence/long-unicode-page4.png` |
| Desktop/mobile visual inspection | Inspected Today and invoices/client screenshots; tested widths 320/390/430 and 1280/1440 | `evidence/*-today.png`, `evidence/*-clients.png`, `evidence/*-invoices.png` |

All test data are synthetic. Test passwords/hashes are synthetic fixtures only; no production owner credential or persistent access grant was created. No hosted application, invoice delivery, processor, payment movement, real-data import, paid service, new cloud task or FreshBooks action was performed. The original repository visibility/access settings were preserved.

## Acceptance cases exercised

- $60/hour client, 90 minutes + 30 minutes → **$120.00** finalized invoice; $25 payment → **$95.00** balance; $95 payment → **$0.00** balance. PDF, backup, and restored relationships/payments agree.
- Integer precision and tie-up line rounding; invalid fractional/negative/boolean monetary fields rejected. Notes-only edits preserve millisecond timestamps and historical rates. Large supported amounts fit 320px. Today totals clip cross-midnight work to the local day.
- Refresh, lost responses, duplicate taps and two tabs preserve one timer and a single completed entry per atomic stop. Client switching captures separate historical rates. First-tap stop atomically saves the current note.
- Invoice selection uniqueness and transaction/version conflicts prevent duplicate billing. Payment retries and competing requests do not duplicate payment records. Client/rate edits cannot change finalized snapshots. Finalized entry editing/deleting is blocked. Void-and-linked-correction history is exercised.
- Anonymous direct state/PDF/CSV/backup APIs are protected. Cross-origin writes are rejected. Production scrypt auth and HttpOnly/Secure/SameSite cookies are exercised with an ephemeral synthetic fixture. Failed-login throttle, session revocation and cross-tab cache-clearing logout are tested.
- Offline start/stop, reload of the cached production shell, reconnect, and generated-ID resolution sync exactly once. Lost-response outboxes remain retryable. Failed saves remain visible/recoverable and forms do not close as successful. Pending-action export/discard is explicit.
- JSON backup → new empty database restore preserves invoice/client/entry/payment links, snapshots and numbering. UI replacement restore works; checksum edits and multiple relationship/amount/sequence corruptions are rejected atomically. Synthetic database-save failure rolls back ledger and receipt together. Timer state survives authentication/process-session loss.

## Run or review

Use the commands in [README.md](../README.md). The checkpoint preview is served at **http://127.0.0.1:8000**, with `APP_TEST_MODE=1` and a synthetic SQLite database in `/tmp`. Password: `synthetic-preview-only`. This loopback URL is a workspace preview, not a hosted phone-accessible production URL. On another machine, install the locked dependencies and start the same command locally. Browser tests use their dedicated `/tmp/time-ledger-browser.sqlite`, and deliberately replace its data; never use a real-data database for tests.

For a fresh synthetic instance:

```bash
cd /workspace/Time-Tracker
source .venv/bin/activate
npm run build
APP_TEST_MODE=1 APP_DB=/tmp/time-ledger-review-fresh.sqlite python -m server.app
```

Stop the existing port-8000 preview first, or set `PORT=8001` with `APP_ORIGIN=http://127.0.0.1:8001` for a parallel synthetic preview. Keep Origin aligned with the chosen port. `git rev-parse HEAD` identifies the packaged revision; committed source, tests, docs and synthetic evidence are the runnable handoff.

## Remaining acceptance gaps

- **Safari/WebKit and physical iPhone are untested.** WebKit browser installation returned network-filter 403 responses from its distribution hosts. Mobile Chromium uses iPhone device dimensions/touch emulation, not the iOS engine. Actual locking, Home Screen installation/standalone lifecycle, Safari downloads, iOS storage eviction and local DST interactions require a physical-device acceptance pass after approved private HTTPS hosting.
- **Private hosting has not been deployed.** See [HOSTING.md](HOSTING.md) for approval boundaries and setup. External HTTPS/proxy/network access and operational backup retention have not been exercised here.
- No long-term load/soak test or external penetration test. This is a small single-owner, single-process ledger. Offline cache and downloads rely on device/filesystem privacy; no application-level cache encryption is claimed. Font coverage for CJK/emoji is not guaranteed.
- The backend test client emits one Starlette/httpx deprecation warning; all tests pass. It affects the synthetic test helper, not runtime API behavior.

The parent should independently run the acceptance flow and inspect the implementation before calling this production-ready. The revision is prepared for that review and subsequent targeted fixes.
