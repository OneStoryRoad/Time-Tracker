# Private hosting preparation — no deployment performed

Use one small Python process plus a persistent local SQLite volume behind an existing private HTTPS reverse proxy. The React build is served by that same process; no separate frontend service, hosted database, processor, paid subscription or third-party runtime API is required. This design intentionally supports one owner and one process, not public multi-tenant hosting. It has no analytics, external fonts or telemetry.

The app is currently reachable only at the workspace loopback URL. A workspace process is not a production deployment, and that URL cannot be opened directly on a physical iPhone elsewhere.

## Decisions/approvals still required

The owner must choose/approve a private host and any costs, private network/access configuration, hostname/TLS setup, production owner credential creation/storage, and backup destination. No production credential, cloud resource, public deployment, persistent grant, invoice delivery, real-data migration or FreshBooks cancellation has been performed. Review and physical iPhone testing must precede real use. This document prepares those actions; it does not authorize them.

## Production configuration after approval

Install/build from the reviewed revision, create a virtual environment, install `requirements-lock.txt`, run `npm ci` and `npm run build`. Set:

```dotenv
APP_ORIGIN=https://YOUR_APPROVED_PRIVATE_HOSTNAME
APP_DB=/YOUR_PERSISTENT_PRIVATE_DATA_DIRECTORY/ledger.sqlite
APP_PASSWORD_HASH=scrypt$OWNER_APPROVED_SALT_HEX$OWNER_APPROVED_DERIVED_HASH_HEX
PORT=8000
```

**Do not set APP_TEST_MODE.** `APP_PASSWORD_HASH` format is `scrypt$salt_hex$hash_hex`, derived with Python `hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=16384, r=8, p=1)`, encoded as hexadecimal. Salt/hash generation and password selection are deferred for owner approval; use a strong unique owner password and a private environment file outside git. The plaintext password is never configured server-side. Do not put credentials in command logs or commit them.

Run `python -m server.app` under an approved service manager, as an unprivileged user with the database directory mode 0700 and a restrictive umask (0077). The process listens only on 127.0.0.1:8000. Proxy the approved **HTTPS** hostname to that loopback port. Keep origin exact (scheme + hostname + optional port, no path); mutations require matching Origin and the app header. The cookie is HttpOnly, Secure and SameSite=Strict. Retain request bodies up to 20 MB through the proxy and configure that body limit at the proxy; do not log bodies/passwords. Rate-limit ingress in addition to the application’s failed-login throttle. Leave API caching disabled. Apply HTTPS/HSTS at the reverse proxy after confirming hostname/TLS. Keep access restricted to the owner through the chosen private network or access gateway.

Use a single process/worker: sessions and login throttling are in memory. Restarting revokes sessions but not ledger/outbox data. No persistent access token or public sign-up is provided. To rotate a password, change the hash and restart the process, revoking all sessions. For server backup, schedule an approved SQLite online backup or authenticated JSON export through a private mechanism after the owner agrees to a destination; no backup automation has been created here.

## Before real use

1. Verify anonymous direct API, invoice PDF, backup and CSV requests all receive 401, and cross-origin writes receive 403.
2. Verify a private HTTPS origin on a physical iPhone in Safari. Add to Home Screen via Share; sign in within the installed app.
3. Exercise start → phone lock → unlock → refresh → stop, offline start/stop → close/reopen → reconnect, long timer review, tab competition, session expiry, and logout with no pending actions.
4. Download and inspect the PDF on iPhone, including long names/addresses/notes and paid/void versions. Supported bundled font covers common Latin/Greek/Cyrillic text; CJK/emoji coverage is not guaranteed.
5. Backup synthetic state, restore to a separate clean instance, check invoice/payment balances and numbering, reject a corrupt file, and verify restart persistence. Agree on ongoing private backup retention and recovery ownership.
6. Only after acceptance and approval, start with empty production state or perform a separately authorized migration. Never import the synthetic evidence backups as real records.

References for the implementation’s persistence and web-app assumptions: [SQLite transactions](https://www.sqlite.org/lang_transaction.html), [WebKit’s web app documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). HTTPS and device validation are deployment acceptance conditions, not claims that a workspace preview has been hosted.
