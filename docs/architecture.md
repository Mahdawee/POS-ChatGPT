# Architecture notes

## Local runtime

```text
Tauri 2 window (React / TypeScript)
              │ HTTP, loopback only
              ▼
        NestJS REST API
              │ Prisma
              ▼
         SQLite in %APPDATA%\DarPOSERP
```

The packaged Tauri process shows the main window immediately and starts the bundled Node runtime and compiled Nest API on a background thread. The frontend polls `/api/auth/health` until the API answers, so a slow first start (antivirus scanning the bundled runtime, cold disk) never blocks or closes the window. The API child is spawned with `CREATE_NO_WINDOW` (no console flash), has a 180-second startup budget, and is stopped when the main window closes. If the API fails to start, the failure is written to `%APPDATA%\DarPOSERP\api.log` and shown in a native error dialog instead of exiting silently. If port 4317 is already served by a previous copy, the new process reuses it instead of spawning a duplicate child that would die with `EADDRINUSE`. The NSIS bundle embeds the WebView2 offline installer so installation works without internet.

**Windows path pitfall:** Tauri resolves its resource directory from a *canonicalized* executable path, which on Windows is verbatim (`\\?\C:\...`). Node.js 22+ crashes with `EISDIR: illegal operation on a directory, lstat 'C:'` when its entry script path carries the `\\?\` prefix, so `main.rs` strips the verbatim prefix (`\\?\` and `\\?\UNC\`) from the resolved runtime path before spawning `node.exe`. Keep that stripping if the path handling ever changes. The development command starts the API and Tauri/Vite together. The local API uses an in-memory random signing key for short-lived bearer sessions; stored passwords are bcrypt hashes. The bundled API's stdout/stderr stream into `api.log`, which is capped at startup (files over 2 MB are truncated to their last 64 KB) so it cannot grow forever.

## Sale consistency

The checkout operation checks active products, quantities, discount, payment amount, customer and open cash session before creating the receipt. It then creates the sale and item snapshots, decrements stock, writes stock movements, and writes the audit record in one Prisma interactive transaction. A client-generated idempotency key makes retries return the original receipt.

## Purchases, sale returns and credit accounts

These flows follow the same transactional pattern as checkout:

- **Purchases** (`POST /api/purchases`): merges duplicate lines, validates active products and safe integer totals, then creates the purchase plus item snapshots, increments stock, refreshes each product's `cost` to the latest purchase price and writes `PURCHASE` movements atomically. `paidAmount` records what was settled at purchase time; the remainder becomes supplier debt (bookkeeping only — it never touches the cash drawer).
- **Sale returns** (`POST /api/sales/:id/return`): validates requested quantities against the invoice items minus already-returned amounts. Restocks the goods with `SALE_RETURN` movements. A full return refunds the discounted sale total; partial returns refund undiscounted line prices. Cash sales take the refund out of the currently open cash session (if any); credit returns reduce the customer's balance by construction.
- **Customer credit** (`GET /api/customers/:id`, `POST /api/customers/:id/payments`): balance = credit sales − credit returns − payments. A payment recorded while a cash session is open also writes an `IN` cash movement, so expected drawer cash stays correct.
- **Supplier credit** (`GET /api/suppliers/:id`, `POST /api/suppliers/:id/payments`): balance = Σ(purchase.total − purchase.paidAmount) − Σ payments. Supplier payments are deliberately bookkeeping-only; paying a supplier from the drawer is a manual cash movement.
- **Profit report** (`GET /api/reports/profit`, admin only): every sale item snapshots `unitCost` at checkout (and every return item snapshots the original sale item's cost), so gross profit = net revenue − Σ(quantity × unitCost) stays historically accurate even when purchase prices change. Sales recorded before v0.3 have no stored cost; the report exposes `unknownCostRevenue` so the UI can warn about over-stated profit for those rows.
- **Debtors report** (`GET /api/reports/debtors`, admin only): customers and suppliers with a positive outstanding balance, sorted by amount, plus totals. Balance math lives in `src/balances.ts` and is shared with the contacts lists.

Printing: receipts, return slips, Z-reports, price labels and reports print through `desktop/src/lib/print.ts`, which builds a fully self-contained HTML document inside a hidden iframe and calls `print()` on the iframe's window. This sidesteps the classic webview pitfall where hiding the app shell for print also hides the modal that holds the receipt (the v0.1 print CSS blanked every printout that way). Receipt documents are 72mm wide for thermal printers; report and label documents use A4. A shop logo (stored as a compact data-URL setting) heads every receipt, and price labels embed a CODE128 SVG generated by JsBarcode. "Microsoft Print to PDF" in the print dialog doubles as PDF export without shipping a PDF library.

Internationalization (`desktop/src/i18n.tsx` + `i18n-dictionaries.ts`): Dari strings are the source of truth and double as dictionary keys, so `t("ذخیره")` returns the Pashto/English entry when one exists and falls back to the Dari text otherwise — a missed translation can never render a raw key. The provider sets `<html dir/lang>` (RTL for fa/ps, LTR for en) before first paint, and layout CSS uses logical properties (border-inline-end, inset-inline-start, text-align: start/match-parent) so the whole UI mirrors cleanly in English. Numbers, dates and money format through locale-aware helpers, and non-React modules (printing, CSV) translate via the same module-level `t()`.

Weighted products: `Product.isWeighted` enables fractional quantities (3 decimal places) in sales, purchases, returns and stock. Money stays whole-afghani (`Int`) — each line total is `Math.round(price × quantity)` — while quantity/stock columns are `Float` in Prisma. Existing SQLite databases keep their INTEGER-affinity columns: SQLite stores fractional values as REAL inside them losslessly, which Prisma's Float fields read back unchanged (verified against a real v0.2 database); fresh databases get REAL columns straight from schema.sql.

LAN mode: `set_network_mode` (Tauri command) writes `%APPDATA%\DarPOSERP\network-mode` — "" / "local" (bundled API on 127.0.0.1), "server" (bundled API on 0.0.0.0, firewall prompt expected) or an http URL (client: no local API, the webview talks to the remote server; CORS reflects any origin and auth stays per-request JWT). The webview API base comes from localStorage and CSP `connect-src` allows LAN http hosts.

Sessions & resilience: `POST /api/auth/refresh` (guarded) issues a fresh 12h token; the desktop renews silently every 4h. An ErrorBoundary wraps the UI so a render crash shows a reload card instead of a white screen. SQLite runs in WAL mode with a daily `PRAGMA optimize`.

Backups: `src/backup.ts` wraps `VACUUM INTO` (never inside a transaction). The manual backup button and the automatic snapshot on every cash close share it; the close path is best-effort so a backup failure can never invalidate the committed close, and auto backups are pruned to the newest 10.

## Database and first run

Prisma schema is the source of truth. A schema SQL script is generated at build/dev start and uses `CREATE TABLE IF NOT EXISTS` at API boot, which lets a fresh installed copy initialize itself without a database server or Prisma CLI. Because `IF NOT EXISTS` cannot add columns to existing tables, `COLUMN_MIGRATIONS` in `prisma.service.ts` backfills every column added after the first release with an idempotent `ALTER TABLE ... ADD COLUMN` (checked via `PRAGMA table_info`); append new entries there when adding columns to existing models and never remove old ones. The first boot inserts starter data only when no user exists. Future schema changes should be shipped as versioned SQLite migrations; do not remove or overwrite a customer's `%APPDATA%\DarPOSERP\pos.db`.

## Windows packaging

`desktop/scripts/prepare-runtime.mjs` copies the current Node executable, the compiled API, its production dependency tree, and the generated Prisma client into Tauri resources. The assembled `src-tauri/resources/` tree and `*.tsbuildinfo` files are gitignored: the runtime is rebuilt from scratch on every package build, and the server build runs with `incremental: false` so a stale build-info file can never make `tsc` skip emitting `dist` (a fresh clone used to end up without `dist/main.js` this way). The Windows NSIS/MSI bundle remains local at runtime. Rust/Tauri build prerequisites are needed only when creating the desktop package.

Because the resources tree is gitignored, a fresh clone has no `resources/runtime` and `tauri dev` used to die in the build script with `resource path 'resources\runtime' doesn't exist` (only `tauri:build` runs `prepare:runtime`). `src-tauri/build.rs` now drops a placeholder folder in debug builds — in dev the API comes from `npm run dev:api` and the bundled runtime is never spawned (`start_bundled_api` is release-only). Release builds deliberately leave the check intact, so packaging without `prepare:runtime` still fails loudly instead of shipping an empty runtime.
