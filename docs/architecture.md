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

The packaged Tauri process starts the bundled Node runtime and compiled Nest API, waits for the loopback port, and stops that child when the main window closes. The development command starts the API and Tauri/Vite together. The local API uses an in-memory random signing key for short-lived bearer sessions; stored passwords are bcrypt hashes.

## Sale consistency

The checkout operation checks active products, quantities, discount, payment amount, customer and open cash session before creating the receipt. It then creates the sale and item snapshots, decrements stock, writes stock movements, and writes the audit record in one Prisma interactive transaction. A client-generated idempotency key makes retries return the original receipt.

## Database and first run

Prisma schema is the source of truth. A schema SQL script is generated at build/dev start and uses `CREATE TABLE IF NOT EXISTS` at API boot, which lets a fresh installed copy initialize itself without a database server or Prisma CLI. The first boot inserts starter data only when no user exists. Future schema changes should be shipped as versioned SQLite migrations; do not remove or overwrite a customer's `%APPDATA%\DarPOSERP\pos.db`.

## Windows packaging

`desktop/scripts/prepare-runtime.mjs` copies the current Node executable, the compiled API, its production dependency tree, and the generated Prisma client into Tauri resources. The Windows NSIS/MSI bundle remains local at runtime. Rust/Tauri build prerequisites are needed only when creating the desktop package.
