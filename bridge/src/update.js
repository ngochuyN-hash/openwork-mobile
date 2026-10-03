// OTA is enabled by default on every installation; config/env can opt out.
// Worker phục vụ 2 key KV tĩnh:
//   `bridge-release:latest` = {version, sha256}   (manifest rẻ, bridge check định kỳ)
//   `bridge-release:files`  = {version, files: {"src/index.js": "<base64>", ...}}
// Chuỗi an toàn: so version → gate (tunnel ổn, không vừa khởi động) → tải
// payload → verify sha256 → giải nén vào STAGE (cùng volume) → verify cấu
// trúc → backup src → swap atomic → arm watchdog + respawn.
// Watchdog đứng NGOÀI process: nếu bridge mới không xác nhận boot-ok trong
// deadline thì tự trả về bản backup — một bản cập nhật vỡ không bao giờ
// làm chết máy. Không thêm dependency nào (payload là base64 plain).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir } from "./config.js";
import { readStateFile, writeStateFile, rollbackBackup } from "../scripts/ota-watchdog.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // bridge/src
export const bridgeRoot = resolve(here, "..");
export const STATE_FILE = join(bridgeRoot, ".ota", "state.json");
export const STAGE_DIR = join(bridgeRoot, ".ota-stage");
export const BACKUP_DIR = join(bridgeRoot, ".ota-backup");
export const VERSION_FILE = join(bridgeRoot, "VERSION");
export const WATCHDOG_SCRIPT = join(bridgeRoot, "scripts", "ota-watchdog.mjs");

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check định kỳ — không poll liên tục
export const RETRY_SOON_MS = 30 * 60 * 1000; // gate tạm (tunnel/uptime) — thử lại sớm
export const MIN_UPTIME_MS = 5 * 60 * 1000; // không restart ngay sau khi bridge vừa dậy (429)
export const WATCHDOG_DEADLINE_MS = 90 * 1000; // bridge mới xác nhận boot trong bao lâu

export function currentVersion(root = bridgeRoot) {
  try {
    const v = readFileSync(versionFileFor(root), "utf8").trim();
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function compareVersions(a, b) {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function shouldUpdateNow({ remote, current, tunnel, uptimeMs, failedVersion = null }) {
  if (!remote?.version || compareVersions(remote.version, current) <= 0) {
    return { ok: false, reason: "no_newer_version" };
  }
  if (failedVersion && remote.version === failedVersion) {
    return { ok: false, reason: "version_failed_previously" };
  }
  if (!tunnel || tunnel.phase !== "up" || !tunnel.url) {
    return { ok: false, reason: "tunnel_not_ready" };
  }
  if (uptimeMs < MIN_UPTIME_MS) return { ok: false, reason: "recently_started" };
  return { ok: true };
}

/** Giải nén payload.files vào stage, chống path traversal. Trả về số file. */
export function extractPayload(payload, stageDir) {
  const root = resolve(stageDir);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const files = payload?.files ?? {};
  let count = 0;
  for (const [rel, b64] of Object.entries(files)) {
    const target = resolve(root, rel);
    if (!(target === root || target.startsWith(root + sep))) {
      throw new Error(`[ota] path thoát stage: ${rel}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(b64, "base64"));
    count += 1;
  }
  // Payload rỗng / thiếu index.js = bản hỏng, đừng đụng gì.
  if (!existsSync(join(root, "src", "index.js"))) {
    throw new Error("[ota] payload thiếu src/index.js");
  }
  return count;
}

export function stateFileFor(root = bridgeRoot) {
  return join(root, ".ota", "state.json");
}
export function stageDirFor(root = bridgeRoot) {
  return join(root, ".ota-stage");
}
export function backupDirFor(root = bridgeRoot) {
  return join(root, ".ota-backup");
}
export function versionFileFor(root = bridgeRoot) {
  return join(root, "VERSION");
}

function readState(root = bridgeRoot) {
  return readStateFile(stateFileFor(root));
}

function writeState(s, root = bridgeRoot) {
  writeStateFile(stateFileFor(root), s);
}

export function trustedWatchdogFor(root = bridgeRoot) {
  return join(root, ".ota", "ota-watchdog.mjs");
}

/**
 * Swap atomic: src → backup, stage/src → src, cập nhật VERSION, arm watchdog.
 * Watchdog spawn detached + elevated (kế thừa token process cha), sống sót khi
 * bridge exit; nó tự thoát nếu thấy phase "done", rollback nếu quá deadline.
 */
export function installRelease(payload, opts = {}) {
  const root = resolve(opts.bridgeRoot ?? bridgeRoot);
  const srcDir = join(root, "src");
  const scriptsDir = join(root, "scripts");
  const stageDir = stageDirFor(root);
  const backupDir = backupDirFor(root);
  const stageSrc = join(stageDir, "src");
  const stageScripts = join(stageDir, "scripts");
  const from = opts.from ?? currentVersion(root);
  const to = String(payload.version ?? from);

  if (["preparing", "applying", "rolling_back"].includes(readState(root)?.phase)) {
    // Lần swap trước chưa xong mà có swap mới — đừng chồng, chờ watchdog lo.
    throw new Error("[ota] đang có update chưa xác nhận, bỏ qua");
  }

  extractPayload(payload, stageDir);

  const replaceScripts = existsSync(stageScripts);
  const state = {
    phase: "preparing", from, to, pid: process.pid, at: Date.now(),
    backupFormat: "bundle-v1", backupReady: false, replaceScripts,
    original: Object.fromEntries(["src", "scripts", "VERSION"].map((name) => [name, existsSync(join(root, name))])),
  };
  // No live-tree or previous-backup mutations until this journal is persisted.
  writeState(state, root);
  let backupReady = false;
  try {
    // Use the currently installed watchdog, never code supplied by this payload.
    copyFileSync(join(scriptsDir, "ota-watchdog.mjs"), trustedWatchdogFor(root));
    rmSync(backupDir, { recursive: true, force: true });
    mkdirSync(backupDir, { recursive: true });
    state.backupReady = true;
    writeState(state, root);
    backupReady = true;
    // Save VERSION before any directory moves (copy failure leaves live files alone).
    if (state.original.VERSION) copyFileSync(versionFileFor(root), join(backupDir, "VERSION"));
    if (state.original.src) renameSync(srcDir, join(backupDir, "src"));
    // Omitted scripts stay live and untouched, including throughout rollback.
    if (state.original.scripts && replaceScripts) renameSync(scriptsDir, join(backupDir, "scripts"));
    renameSync(stageSrc, srcDir);
    if (replaceScripts) renameSync(stageScripts, scriptsDir);
    // The verified manifest is authoritative, even when payload VERSION is absent/stale.
    writeFileSync(versionFileFor(root), to, "utf8");
    writeState({ ...state, phase: "applying" }, root);
  } catch (e) {
    try {
      if (!backupReady || !restoreBackup(root)) {
        writeState({ ...state, phase: "failed", failedVersion: to }, root);
      }
    } catch (recoveryError) {
      throw new AggregateError([e, recoveryError], `[ota] cài lỗi: ${e.message}; rollback lỗi: ${recoveryError.message}`);
    }
    throw e;
  }
  return to;
}

/** Bridge mới boot OK sau khi listen — báo cho watchdog thoát. */
export function markBootOk(root = bridgeRoot) {
  const s = readState(root);
  if (s?.phase === "applying") {
    const { failedVersion, ...rest } = s;
    writeState({ ...rest, phase: "done", readyAt: Date.now() }, root);
  }
}

async function respawnAndExit(log) {
  const script = join(bridgeRoot, "src", "index.js");
  // stdout/stderr của đời mới đổ vào log riêng — không nối vào console cũ đã chết.
  const out = join(bridgeDataDir(), "ota.log");
  let fd;
  try {
    fd = openSync(out, "a");
  } catch {
    fd = 1;
  }
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true, // không mở cửa sổ console trên desktop người dùng
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    if (fd !== 1) closeSync(fd);
  }
  // Cho log kịp in xong rồi mới nhường.
  setTimeout(() => process.exit(0), 500);
}

/**
 * Khởi động bộ OTA. MẶC ĐỊNH BẬT trên mọi máy (16/09 tối, owner: "không muốn
 * lệ thuộc máy, dù gì cũng chỉ dùng setup" — máy nào cũng chỉ là người dùng);
 * tắt bằng config.ota === false hoặc env OPENWORK_BRIDGE_OTA=0. WIP chưa commit
 * trên máy repo không mất: bản cũ (kèm WIP) nằm nguyên trong .ota-backup/
 * cho tới lần swap kế — hồi lại bằng tay nếu cần.
 */
export function startUpdater({ config, getTunnelState, log = console.log }) {
  const enabled = process.env.OPENWORK_BRIDGE_OTA !== "0" && config.ota !== false;
  if (!enabled) {
    log("[ota] tắt (config.ota=false hoặc OPENWORK_BRIDGE_OTA=0).");
    return;
  }
  if (!config.lookupUrl) {
    log("[ota] thiếu lookupUrl (máy không nối worker) — bỏ qua.");
    return;
  }
  const base = String(config.lookupUrl).replace(/\/+$/, "");
  let installing = false;

  const check = async () => {
    if (installing) return;
    const current = currentVersion();
    let remote = null;
    try {
      const res = await fetch(`${base}/bridge-release`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) remote = await res.json();
    } catch (e) {
      log(`[ota] check lỗi: ${e.message}`);
      return schedule(CHECK_INTERVAL_MS);
    }
    if (!remote?.version) return schedule(CHECK_INTERVAL_MS);
    if (compareVersions(remote.version, current) <= 0) return schedule(CHECK_INTERVAL_MS);

    const state = readState(bridgeRoot);
    const gate = shouldUpdateNow({
      remote,
      current,
      tunnel: getTunnelState(),
      uptimeMs: process.uptime() * 1000,
      failedVersion: state?.failedVersion ?? null,
    });
    if (!gate.ok) {
      log(`[ota] bản mới ${remote.version} nhưng ${gate.reason} — thử lại sau.`);
      return schedule(
        gate.reason === "no_newer_version" || gate.reason === "version_failed_previously"
          ? CHECK_INTERVAL_MS
          : RETRY_SOON_MS
      );
    }

    let payloadText = null;
    try {
      const res = await fetch(`${base}/bridge-release/files`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`files HTTP ${res.status}`);
      payloadText = await res.text();
    } catch (e) {
      log(`[ota] tải payload lỗi: ${e.message}`);
      return schedule(RETRY_SOON_MS);
    }
    if (sha256Hex(Buffer.from(payloadText)) !== remote.sha256) {
      log("[ota] sha256 KHÔNG khớp manifest — bỏ qua (nguồn lạ?).");
      return schedule(CHECK_INTERVAL_MS);
    }
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      log("[ota] payload hỏng (JSON sai) — bỏ qua.");
      return schedule(CHECK_INTERVAL_MS);
    }

    installing = true;
    log(`[ota] cập nhật ${current} → ${remote.version}...`);
    try {
      const to = installRelease({ version: remote.version, files: payload.files ?? {} });
      log(`[ota] swap xong (${to}), khởi động watchdog + respawn.`);
      const watch = spawn(process.execPath, [
        trustedWatchdogFor(),
        String(process.pid),
        STATE_FILE,
        bridgeRoot,
        join(bridgeRoot, "src", "index.js"),
        bridgeDataDir(),
      ], { detached: true, stdio: "ignore", windowsHide: true });
      await new Promise((resolve, reject) => {
        watch.once("spawn", resolve);
        watch.once("error", reject);
      });
      watch.unref();
      await respawnAndExit(log);
    } catch (e) {
      try {
        if (readState()?.phase === "applying") restoreBackup();
      } catch (recoveryError) {
        log(`[ota] rollback cần can thiệp: ${recoveryError.message}`);
      }
      log(`[ota] cài thất bại: ${e.message}`);
      installing = false;
      schedule(RETRY_SOON_MS);
    }
  };

  const schedule = (ms) => setTimeout(check, ms);
  // Sau boot 30s check lần đầu (tunnel kịp "up"), rồi mỗi 6h.
  setTimeout(check, 30_000);
}

/** Phục hồi backup (dùng cho test / lệnh tay khi watchdog chết). */
export function restoreBackup(root = bridgeRoot) {
  return rollbackBackup(root, stateFileFor(root));
}