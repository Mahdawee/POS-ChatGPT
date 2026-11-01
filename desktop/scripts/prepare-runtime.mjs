import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const projectDir = resolve(desktopDir, "..");
const runtimeDir = join(desktopDir, "src-tauri", "resources", "runtime");
const serverDir = join(projectDir, "server");
const nmDir = join(serverDir, "node_modules");
const runtimeCopyFilter = (source) => {
  const normalized = source.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (normalized.split("/").some((part) => ["test", "tests", "__tests__"].includes(part))) return false;
  return !name.endsWith(".map") && !name.includes(".test.") && !name.includes(".spec.");
};

if (process.platform !== "win32") throw new Error("The packaged desktop runtime currently targets Windows.");
if (!requireExists(join(serverDir, "dist", "main.js"))) throw new Error("Build the API first: npm run build:api");
rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(join(runtimeDir, "server"), { recursive: true });
cpSync(process.execPath, join(runtimeDir, "node.exe"));
cpSync(join(serverDir, "dist"), join(runtimeDir, "server", "dist"), { recursive: true, filter: runtimeCopyFilter });
cpSync(join(serverDir, "prisma"), join(runtimeDir, "server", "prisma"), { recursive: true, filter: runtimeCopyFilter });
cpSync(join(serverDir, "package.json"), join(runtimeDir, "server", "package.json"));

const listCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
const listArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm ls --parseable --all --omit=dev"] : ["ls", "--parseable", "--all", "--omit=dev"];
const listed = execFileSync(listCommand, listArgs, { cwd: serverDir, encoding: "utf8" });
mkdirSync(join(runtimeDir, "node_modules"), { recursive: true });
const rootNodeModules = resolve(nmDir) + sep;
for (const entry of listed.split(/\r?\n/).filter(Boolean).map((path) => resolve(serverDir, path))) {
  if (!entry.startsWith(rootNodeModules)) continue;
  const rel = relative(nmDir, entry);
  if (!rel || rel.startsWith("..")) continue;
  cpSync(entry, join(runtimeDir, "node_modules", rel), { recursive: true, dereference: true, force: true, filter: runtimeCopyFilter });
}
const prismaRuntime = join(nmDir, ".prisma", "client");
cpSync(prismaRuntime, join(runtimeDir, "node_modules", ".prisma", "client"), { recursive: true, dereference: true, force: true, filter: runtimeCopyFilter });
console.log(`Windows runtime assembled at ${runtimeDir}`);

function requireExists(path) {
  return existsSync(path);
}
