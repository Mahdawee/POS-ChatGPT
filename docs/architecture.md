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

**Windows path pitfall:** Tauri resolves its resource directory from a *canonicalized* executable path, which on Windows is verbatim (`\\?\C:\...`). Node.js 22+ crashes with `EISDIR: illegal operation on a directory, lstat 'C:'` when its entry script path carries the `\\?\` prefix, so `main.rs` strips the verbatim prefix (`\\?\` and `\\?\UNC\`) from the resolved runtime path before spawning `node.exe`. Keep that stripping if the path handling ever changes. The development command starts the API and Tauri/Vite together. The local API uses an in-memory random signing key for short-lived bearer sessions; stored passwords are bcrypt hashes.

## Sale consistency

The checkout operation checks active products, quantities, discount, payment amount, customer and open cash session before creating the receipt. It then creates the sale and item snapshots, decrements stock, writes stock movements, and writes the audit record in one Prisma interactive transaction. A client-generated idempotency key makes retries return the original receipt.

## Database and first run

Prisma schema is the source of truth. A schema SQL script is generated at build/dev start and uses `CREATE TABLE IF NOT EXISTS` at API boot, which lets a fresh installed copy initialize itself without a database server or Prisma CLI. The first boot inserts starter data only when no user exists. Future schema changes should be shipped as versioned SQLite migrations; do not remove or overwrite a customer's `%APPDATA%\DarPOSERP\pos.db`.

## Windows packaging

`desktop/scripts/prepare-runtime.mjs` copies the current Node executable, the compiled API, its production dependency tree, and the generated Prisma client into Tauri resources. The assembled `src-tauri/resources/` tree and `*.tsbuildinfo` files are gitignored: the runtime is rebuilt from scratch on every package build, and the server build runs with `incremental: false` so a stale build-info file can never make `tsc` skip emitting `dist` (a fresh clone used to end up without `dist/main.js` this way). The Windows NSIS/MSI bundle remains local at runtime. Rust/Tauri build prerequisites are needed only when creating the desktop package.
