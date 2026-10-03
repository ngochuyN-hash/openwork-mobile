// Standalone OTA watchdog. Copied into .ota before scripts/ is replaced.
// ARGV: <oldPid> <stateFile> <bridgeRoot> <entryScript> [dataDir]
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function readStateFile(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

// A failed write must stop the transaction, never leave a truncated journal.
export function writeStateFile(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "w");
    writeFileSync(fd, JSON.stringify(state) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(temporary, file);
}

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

/** Restore each saved component independently; a partial bundle is NOT flat src. */
export function rollbackBackup(root, stateFile = join(root, ".ota", "state.json")) {
  const backup = join(root, ".ota-backup");
  const state = readStateFile(stateFile) ?? {};
  const transaction = state.backupFormat === "bundle-v1";
  if (transaction && !state.backupReady) return false;
  const saved = ["src", "scripts", "VERSION"].filter((name) => existsSync(join(backup, name)));
  const legacy = !transaction && saved.length === 0 && isFile(join(backup, "index.js"));
  if (!saved.length && !legacy) return false;

  // Persist recovery intent before deleting or moving any live component.
  const recovering = { ...state, phase: "rolling_back", failedVersion: state.to ?? null };
  writeStateFile(stateFile, recovering);
  if (legacy) {
    rmSync(join(root, "src"), { recursive: true, force: true });
    renameSync(backup, join(root, "src"));
    // Older releases did not save VERSION; use their journal when available.
    if (state.from) writeFileSync(join(root, "VERSION"), String(state.from), "utf8");
  } else {
    for (const name of ["src", "scripts"]) {
      const source = join(backup, name);
      const target = join(root, name);
      if (existsSync(source)) {
        rmSync(target, { recursive: true, force: true });
        renameSync(source, target);
      } else if (transaction && state.original?.[name] === false && (name === "src" || state.replaceScripts)) {
        rmSync(target, { recursive: true, force: true });
      }
    }
    if (existsSync(join(backup, "VERSION"))) {
      copyFileSync(join(backup, "VERSION"), join(root, "VERSION"));
    } else if (transaction && state.original?.VERSION === false) {
      rmSync(join(root, "VERSION"), { force: true });
    }
  }
  writeStateFile(stateFile, { ...recovering, phase: "rollback", rolledBackAt: Date.now() });
  rmSync(backup, { recursive: true, force: true });
  return true;
}

export function watchdogPaths(stateFile, dataDir) {
  const directory = dataDir || dirname(stateFile); // four-argument old launcher
  return { directory, log: join(directory, "ota-watchdog.log"), output: join(directory, "ota.log") };
}

export async function runWatchdog([pidOld, stateFile, bridgeRoot, entryScript, dataDir]) {
  const paths = watchdogPaths(stateFile, dataDir);
  const log = (msg) => {
    try {
      mkdirSync(paths.directory, { recursive: true });
      writeFileSync(paths.log, `${new Date().toISOString()} ${msg}\n`, { flag: "a" });
    } catch {}
  };
  const oldPidAlive = () => {
    try { process.kill(Number(pidOld), 0); return true; }
    catch (e) { return e.code === "EPERM"; }
  };
  const t0 = Date.now();
  while (oldPidAlive() && Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (oldPidAlive()) {
    log("pid cũ vẫn sống sau 15s — thoát không đụng.");
    return;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = readStateFile(stateFile);
    if (!s || ["done", "rollback", "failed"].includes(s.phase)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const state = readStateFile(stateFile);
  if (!["preparing", "applying", "rolling_back"].includes(state?.phase)) return;
  log("DEADLINE — bản mới không xác nhận, rollback về backup.");
  try {
    if (!rollbackBackup(bridgeRoot, stateFile)) {
      log("Không có backup hợp lệ — giữ nguyên cây hiện tại, không respawn.");
      return;
    }
    mkdirSync(paths.directory, { recursive: true });
    const fd = openSync(paths.output, "a");
    try {
      const child = spawn(process.execPath, [entryScript], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
      child.on("error", (e) => log(`respawn lỗi: ${e.message}`));
      child.unref();
    } finally { closeSync(fd); }
    log("đã respawn bridge bản cũ.");
  } catch (e) {
    log(`rollback lỗi: ${e.message}`);
  }
}

// Importable for isolated tests and updater recovery; imports never start a process.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runWatchdog(process.argv.slice(2));
}
