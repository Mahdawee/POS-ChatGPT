const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");

const dataDir = resolve(process.env.POS_DATA_DIR || join(process.env.APPDATA || join(homedir(), ".local", "share"), "DarPOSERP"));
const args = process.argv.slice(2);
if (args[0] === "db" || args[0] === "studio") mkdirSync(dataDir, { recursive: true });
process.env.DATABASE_URL ||= `file:${join(dataDir, "pos.db").replace(/\\/g, "/")}`;
const prismaCli = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [prismaCli, ...args], { stdio: "inherit", env: process.env });
if (result.status === 0 && args[0] === "migrate" && args[1] === "diff") {
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0 && args[outputIndex + 1]) {
    const outputPath = resolve(process.cwd(), args[outputIndex + 1]);
    const schema = readFileSync(outputPath, "utf8")
      .replace(/\bCREATE TABLE\b/g, "CREATE TABLE IF NOT EXISTS")
      .replace(/\bCREATE UNIQUE INDEX\b/g, "CREATE UNIQUE INDEX IF NOT EXISTS")
      .replace(/\bCREATE INDEX\b/g, "CREATE INDEX IF NOT EXISTS");
    writeFileSync(outputPath, schema, "utf8");
  }
}
process.exit(result.status ?? 1);
