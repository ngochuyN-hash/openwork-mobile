// OTA cập nhật bridge từ xa (16/09/2026) — máy bạn bè tự nhận bản bridge mới,
// không cần ai đụng tay; máy dev (có .git) MẶC ĐỊNH TẮT để không ghi đè working
// tree. Worker phục vụ 2 key KV tĩnh:
//   `bridge-release:latest` = {version, sha256}   (manifest rẻ, bridge check định kỳ)
//   `bridge-release:files`  = {version, files: {"src/index.js": "<base64>", ...}}
// Chuỗi an toàn: so version → gate (tunnel ổn, không ai đang xem, không vừa
// khởi động) → tải payload → verify sha256 → giải nén vào STAGE (cùng volume)
// → verify cấu trúc → backup src → swap atomic → arm watchdog + respawn.
// Watchdog đứng NGOÀI process: nếu bridge mới không xác nhận boot-ok trong
// deadline thì tự trả về bản backup — một bản cập nhật vỡ không bao giờ
// làm chết máy. Không thêm dependency nào (payload là base64 plain).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url)); // bridge/src
export const bridgeRoot = resolve(here, "..");
export const STATE_FILE = join(bridgeRoot, ".ota", "state.json");
export const STAGE_DIR = join(bridgeRoot, ".ota-stage");
export const BACKUP_DIR = join(bridgeRoot, ".ota-backup");
export const VERSION_FILE = join(bridgeRoot, "VERSION");
export const WATCHDOG_SCRIPT = join(bridgeRoot, "scripts", "ota-watchdog.mjs");

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check định kỳ — không poll liên tục
export const RETRY_SOON_MS = 30 * 60 * 1000; // gate tạm (tunnel/viewer/uptime) — thử lại sớm
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

export function shouldUpdateNow({ remote, current, tunnel, viewerCount, uptimeMs }) {
  if (!remote?.version || compareVersions(remote.version, current) <= 0) {
    return { ok: false, reason: "no_newer_version" };
  }
  if (!tunnel || tunnel.phase !== "up" || !tunnel.url) {
    return { ok: false, reason: "tunnel_not_ready" };
  }
  if (viewerCount > 0) return { ok: false, reason: "viewers_active" };
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
  const file = stateFileFor(root);
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

function writeState(s, root = bridgeRoot) {
  const file = stateFileFor(root);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s) + "\n", "utf8");
  } catch (e) {
    console.error("[ota] không ghi được state:", e.message);
  }
}

/**
 * Swap atomic: src → backup, stage/src → src, cập nhật VERSION, arm watchdog.
 * Watchdog spawn detached + elevated (kế thừa token process cha), sống sót khi
 * bridge exit; nó tự thoát nếu thấy phase "done", rollback nếu quá deadline.
 */
export function installRelease(payload, opts = {}) {
  const root = resolve(opts.bridgeRoot ?? bridgeRoot);
  const srcDir = join(root, "src");
  const stageDir = stageDirFor(root);
  const backupDir = backupDirFor(root);
  const stageSrc = join(stageDir, "src");
  const from = opts.from ?? currentVersion();
  const to = String(payload.version ?? from);

  if (readState(root)?.phase === "applying") {
    // Lần swap trước chưa xong mà có swap mới — đừng chồng, chờ watchdog lo.
    throw new Error("[ota] đang có update chưa xác nhận, bỏ qua");
  }

  extractPayload(payload, stageDir);
  // Cùng volume → rename atomic, không có trạng thái "cài dở giữa chừng".
  rmSync(backupDir, { recursive: true, force: true });
  renameSync(srcDir, backupDir);
  try {
    renameSync(stageSrc, srcDir);
    const vInStage = join(stageDir, "VERSION");
    if (existsSync(vInStage)) {
      writeFileSync(versionFileFor(root), readFileSync(vInStage));
    }
    // Watchdog nằm ngoài src/ (bridgeRoot/scripts) — payload có kèm thì thăng cấp luôn.
    const scriptsInStage = join(stageDir, "scripts");
    if (existsSync(scriptsInStage)) {
      rmSync(join(root, "scripts"), { recursive: true, force: true });
      renameSync(scriptsInStage, join(root, "scripts"));
    }
  } catch (e) {
    // Swap lỗi giữa chừng: trả nguyên bản cũ rồi ném.
    rmSync(srcDir, { recursive: true, force: true });
    renameSync(backupDir, srcDir);
    throw e;
  }
  writeState({ phase: "applying", from, to, pid: process.pid, at: Date.now() }, root);
  return to;
}

/** Bridge mới boot OK sau khi listen — báo cho watchdog thoát. */
export function markBootOk(root = bridgeRoot) {
  const s = readState(root);
  if (s?.phase === "applying") {
    writeState({ ...s, phase: "done", readyAt: Date.now() }, root);
  }
}

function respawnAndExit(log) {
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
    });
    child.unref();
  } catch (e) {
    log(`[ota] respawn lỗi: ${e.message}`);
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
export function startUpdater({ config, getTunnelState, getViewerCount, log = console.log }) {
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
  let timers = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const check = async () => {
    if (timers > 2) return; // watchdog đang lo việc swap, ngừng vòng mới
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

    const gate = shouldUpdateNow({
      remote,
      current,
      tunnel: getTunnelState(),
      viewerCount: getViewerCount(),
      uptimeMs: process.uptime() * 1000,
    });
    if (!gate.ok) {
      log(`[ota] bản mới ${remote.version} nhưng ${gate.reason} — thử lại sau.`);
      return schedule(gate.reason === "no_newer_version" ? CHECK_INTERVAL_MS : RETRY_SOON_MS);
    }

    let payloadText = null;
    try {
      const res = await fetch(`${base}/bridge-release/files`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`files HTTP ${res.status}`);
      payloadText = await res.text();
    } catch (e) {
      log(`[ota] tải payload lỗi: ${e.message}`);
      timers += 1;
      setTimeout(check, RETRY_SOON_MS);
      return;
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

    timers += 1; // chặn vòng mới trong lúc swap
    log(`[ota] cập nhật ${current} → ${remote.version}...`);
    try {
      const to = installRelease({ version: remote.version, files: payload.files ?? {} });
      log(`[ota] swap xong (${to}), khởi động watchdog + respawn.`);
      const watch = spawn(process.execPath, [
        WATCHDOG_SCRIPT,
        String(process.pid),
        STATE_FILE,
        bridgeRoot,
        join(bridgeRoot, "src", "index.js"),
      ], { detached: true, stdio: "ignore" });
      watch.unref();
      respawnAndExit(log);
    } catch (e) {
      log(`[ota] cài thất bại (đã trả lại bản cũ): ${e.message}`);
      timers -= 1;
      setTimeout(check, RETRY_SOON_MS);
    }
  };

  const schedule = (ms) => setTimeout(check, ms);
  // Sau boot 30s check lần đầu (tunnel kịp "up"), rồi mỗi 6h.
  setTimeout(check, 30_000);
}

/** Phục hồi backup (dùng cho test / lệnh tay khi watchdog chết). */
export function restoreBackup(root = bridgeRoot) {
  const srcDir = join(root, "src");
  const backupDir = backupDirFor(root);
  if (!existsSync(backupDir)) return false;
  rmSync(srcDir, { recursive: true, force: true });
  renameSync(backupDir, srcDir);
  writeState({ ...readState(root), phase: "rollback", at: Date.now() }, root);
  return true;
}