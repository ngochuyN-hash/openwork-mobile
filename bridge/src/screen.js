// Xem + điều khiển màn hình máy tính từ điện thoại — học cơ chế của 9remote
// (mổ xẻ từ bản npm trên máy chủ nhà): chụp bằng node-screenshots, nén JPEG
// bằng sharp, điều khiển bằng daemon C# tự compile bằng csc (SendInput thuần).
//
// Nguyên tắc như 9remote: KHÔNG ghi ảnh ra đĩa — frame sống trong RAM, đẩy xong
// là vứt; không ai xem thì dừng chụp, giải phóng daemon (lifecycle "Remote
// streaming stopped" của họ).
//
// Stream protocol (HTTP chunked, binary):
//   mỗi frame = [4 byte BE: độ dài payload][1 byte type][payload]
//   type 0 = màn đứng yên (payload rỗng) · 1 = JPEG · 2 = meta JSON · 3 = lỗi JSON
import sharp from "sharp";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = platform() === "win32";

const MAX_VIEWERS = 3; // chặn 1 người mở nhiều tab phá CPU
const IDLE_STOP_MS = 90_000; // không ai xem 90s -> dừng chụp + kill daemon
const FRAME_MIN_INTERVAL = 250; // ~3-4 hình/giây tối đa
const MAX_PENDING_BYTES = 3_000_000; // viewer chậm quá thì đá (client tự nối lại)

export const FRAME_UNCHANGED = 0;
export const FRAME_JPEG = 1;
export const FRAME_META = 2;
export const FRAME_ERROR = 3;

/** Mã 1 frame ra binary: [4B len][1B type][payload]. */
export function encodeFrame(type, payload = null) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload ? payload.length : 0, 0);
  head.writeUInt8(type, 4);
  return payload ? Buffer.concat([head, payload]) : head;
}

/** Rate limiter trượt đơn giản theo IP — dùng cho route input. */
export function createRateLimiter(max, windowMs) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    const limited = list.length >= max;
    if (!limited) list.push(now);
    hits.set(ip, list);
    return limited;
  };
}

// ---------------------------------------------------------------------------
// Bản đồ phím -> validate ở phía bridge (daemon C# có bản đồ riêng giống hệt).
// ---------------------------------------------------------------------------
export const KEY_NAMES = new Set([
  "enter", "esc", "tab", "backspace", "delete", "home", "end", "pgup", "pgdn",
  "up", "down", "left", "right", "space", "win", "ctrl", "alt", "shift",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const MOD_NAMES = new Set(["ctrl", "alt", "shift", "win"]);

function keyToDaemon(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (n.length === 1) {
    const c = n.toUpperCase();
    if ((c >= "0" && c <= "9") || (c >= "A" && c <= "Z")) return c;
  }
  if (!KEY_NAMES.has(n)) throw new Error(`Phím không hỗ trợ: ${n}`);
  return n;
}

/**
 * Đổi body JSON từ phone thành 1 dòng lệnh cho daemon C# (xem desktop-input.cs).
 * Tọa độ client gửi chuẩn hóa 0..1 theo khung hình chụp — nhân với kích thước
 * màn thật tại đây để daemon chỉ làm việc với pixel thuần.
 */
export function normalizeInput(body, dims) {
  if (!dims) throw new Error("Chưa biết kích thước màn hình");
  const px = (v, total, label) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < -0.02 || n > 1.02) throw new Error(`${label} phải là số 0..1`);
    return Math.round(Math.min(1, Math.max(0, n)) * (total - 1));
  };
  const clampNotch = (v) => Math.min(10, Math.max(-10, Math.round(Number(v) || 0)));
  const type = String(body?.type ?? "").trim();

  switch (type) {
    case "move":
    case "down":
    case "up": {
      const x = px(body.x, dims.width, "x");
      const y = px(body.y, dims.height, "y");
      if (type === "move") return `MOVE|${x}|${y}`;
      const btn = [1, 2, 3].includes(Number(body.button)) ? Number(body.button) : 1;
      return `${type.toUpperCase()}|${x}|${y}|${btn}`;
    }
    case "click":
    case "rclick":
    case "dbl": {
      const x = px(body.x, dims.width, "x");
      const y = px(body.y, dims.height, "y");
      const btn = type === "rclick" ? 2 : 1;
      const dbl = type === "dbl" ? 1 : 0;
      return `CLICK|${x}|${y}|${btn}|${dbl}`;
    }
    case "wheel":
      return `WHEEL|${clampNotch(body.dx)}|${clampNotch(body.dy)}`;
    case "key":
      return `KEY|${keyToDaemon(body.key)}`;
    case "combo": {
      const mods = Array.isArray(body.mods) ? body.mods.map(String) : [];
      if (!mods.length || mods.length > 4 || mods.some((m) => !MOD_NAMES.has(m))) {
        throw new Error("mods chỉ nhận ctrl/alt/shift/win");
      }
      return `COMBO|${mods.join(",")}|${keyToDaemon(body.key)}`;
    }
    case "text": {
      const s = String(body.text ?? "");
      if (!s.length || s.length > 500) throw new Error("text phải 1..500 ký tự");
      return `TEXT|${Buffer.from(s, "utf8").toString("base64")}`;
    }
    default:
      throw new Error(`Lệnh không hỗ trợ: ${type}`);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sha1(buf) {
  return createHash("sha1").update(buf).digest("hex");
}
function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout ?? ""));
    });
  });
}

// ---------------------------------------------------------------------------
// ScreenService: chia sẻ 1 vòng lặp chụp cho mọi người xem + daemon input.
// ---------------------------------------------------------------------------
export class ScreenService {
  constructor() {
    this.available = IS_WINDOWS;
    this.setupError = null;
    this.monitor = null; // { ref, width, height }
    this.viewers = new Set();
    this.looping = false;
    this.lastHashByParams = new Map(); // "w x q" -> hash JPEG gần nhất
    this.lastJpegByParams = new Map();
    this.daemon = null; // { proc, pending: Map }
    this.daemonSeq = 0;
    this.idleTimer = null;
  }

  dims() {
    return this.monitor ? { width: this.monitor.width, height: this.monitor.height } : null;
  }

  async ensureMonitor() {
    if (this.monitor) return this.monitor;
    const mod = await import("node-screenshots");
    const all = (mod.Monitor ?? mod.default?.Monitor).all() ?? [];
    const ref = all.find((m) => m.isPrimary?.()) ?? all[0];
    if (!ref) throw new Error("Không tìm thấy màn hình nào");
    this.monitor = { ref, width: ref.width(), height: ref.height() };
    return this.monitor;
  }

  // ----------------------------------------------------------------- stream
  addViewer(req, res, { w, q }) {
    if (!this.available) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "screen_unavailable", message: this.setupError ?? "Chỉ hỗ trợ Windows" }));
      return;
    }
    if (this.viewers.size >= MAX_VIEWERS) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "too_many_viewers", message: `Tối đa ${MAX_VIEWERS} người xem cùng lúc` }));
      return;
    }
    const width = Math.min(1600, Math.max(320, Math.round(Number(w) || 880)));
    const quality = Math.min(85, Math.max(30, Math.round(Number(q) || 55)));
    const viewer = { res, width, quality, alive: true };

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    this.viewers.add(viewer);
    req.on("close", () => this.removeViewer(viewer));
    res.on("error", () => this.removeViewer(viewer));

    this.sendTo(viewer, FRAME_META, Buffer.from(JSON.stringify({
      screenW: this.monitor?.width ?? 0,
      screenH: this.monitor?.height ?? 0,
      shotW: width, shotH: 0, quality,
    })));
    // Khung gần nhất cùng tham số -> cho xem ngay không phải đợi nhịp chụp
    const key = `${width}x${quality}`;
    if (this.lastJpegByParams.get(key)) this.sendTo(viewer, FRAME_JPEG, this.lastJpegByParams.get(key));

    this.wakeLoop();
    this.touch();
  }

  broadcastMeta() {
    const dims = this.dims();
    if (!dims) return;
    this.broadcast(FRAME_META, Buffer.from(JSON.stringify({
      screenW: dims.width, screenH: dims.height, shotW: 0, shotH: 0, quality: 0,
    })));
  }

  removeViewer(viewer) {
    if (!viewer || !this.viewers.has(viewer)) return;
    viewer.alive = false;
    this.viewers.delete(viewer);
    if (this.viewers.size === 0) this.scheduleIdleStop();
  }

  sendTo(viewer, type, payload) {
    if (!viewer.alive) return;
    try {
      if (viewer.res.writableLength > MAX_PENDING_BYTES) {
        // Người xem chậm/kẹt đường truyền — ngắt cho client tự nối lại, đừng
        // để memory phình (9remote làm tương tự khi tile ack không về).
        viewer.alive = false;
        this.viewers.delete(viewer);
        viewer.res.destroy();
        if (this.viewers.size === 0) this.scheduleIdleStop();
        return;
      }
      viewer.res.write(encodeFrame(type, payload));
    } catch {
      this.removeViewer(viewer);
    }
  }

  broadcast(type, payload) {
    for (const v of [...this.viewers]) this.sendTo(v, type, payload);
  }

  wakeLoop() {
    if (this.looping) return;
    this.looping = true;
    (async () => {
      try {
        await this.ensureMonitor();
        this.broadcastMeta();
        let errorStreak = 0;
        while (this.viewers.size > 0) {
          const t0 = Date.now();
          try {
            await this.captureOnce();
            errorStreak = 0;
          } catch (error) {
            errorStreak += 1;
            if (errorStreak === 3) {
              this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({
                message: `Chụp màn hình lỗi: ${error.message} (màn khóa/UAC sẽ như vậy)`,
              })));
            }
            await delay(1000);
            continue;
          }
          const elapsed = Date.now() - t0;
          await delay(Math.max(30, FRAME_MIN_INTERVAL - elapsed));
        }
      } catch (error) {
        this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({ message: String(error.message ?? error) })));
      } finally {
        this.looping = false;
      }
    })();
  }

  async captureOnce() {
    // Gom người xem theo tham số (w,q) — encode mỗi nhóm đúng 1 lần.
    const groups = new Map();
    for (const v of this.viewers) {
      const key = `${v.width}x${v.quality}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }

    const img = this.monitor.ref.captureImageSync();
    const raw = img.toRawSync(); // RGBA — đã đối chiếu khớp PNG decode
    for (const [key, viewers] of groups) {
      const [w, q] = key.split("x").map(Number);
      const jpeg = await sharp(raw, { raw: { width: img.width, height: img.height, channels: 4 } })
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality: q })
        .toBuffer();
      const hash = sha1(jpeg);
      const unchanged = this.lastHashByParams.get(key) === hash;
      this.lastHashByParams.set(key, hash);
      this.lastJpegByParams.set(key, jpeg);
      for (const v of viewers) {
        if (unchanged) this.sendTo(v, FRAME_UNCHANGED);
        else this.sendTo(v, FRAME_JPEG, jpeg);
      }
    }
  }

  // ------------------------------------------------------------------ input
  touch() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleStop() {
    this.touch();
    this.idleTimer = setTimeout(() => {
      if (this.viewers.size === 0) {
        this.stopDaemon();
        this.lastHashByParams.clear();
        this.lastJpegByParams.clear();
        this.monitor = null; // lần xem sau dò lại (độ phân giải có thể đã đổi)
      }
    }, IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  async input(body) {
    if (!this.available) throw new Error(this.setupError ?? "Điều khiển chỉ hỗ trợ Windows");
    await this.ensureMonitor();
    await this.ensureDaemon();
    const line = normalizeInput(body, this.dims());
    const reply = await this.sendDaemon(line);
    if (reply.err) throw new Error(reply.err);
    this.touch();
    return this.dims();
  }

  // ---------------------------------------------------------- daemon C#
  async ensureDaemon() {
    if (this.daemon && this.daemon.proc.exitCode === null) return this.daemon;
    const exe = await this.compileInputExe();
    const proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const daemon = { proc, pending: new Map(), buffer: "" };
    this.daemon = daemon;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      daemon.buffer += chunk;
      let idx;
      while ((idx = daemon.buffer.indexOf("\n")) >= 0) {
        const line = daemon.buffer.slice(0, idx).trim();
        daemon.buffer = daemon.buffer.slice(idx + 1);
        if (!line) continue;
        const [id, status, ...rest] = line.split("|");
        const pending = daemon.pending.get(id);
        if (!pending) continue;
        daemon.pending.delete(id);
        clearTimeout(pending.timer);
        if (status === "OK") pending.resolve({ err: null, extra: rest.join("|") });
        else pending.resolve({ err: rest.join("|") || "daemon lỗi không rõ" });
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => console.error("[screen-daemon]", String(c).trim()));
    proc.on("exit", () => {
      for (const [, p] of daemon.pending) {
        clearTimeout(p.timer);
        p.resolve({ err: "daemon điều khiển vừa thoát" });
      }
      daemon.pending.clear();
      if (this.daemon === daemon) this.daemon = null;
    });

    // PING đầu tiên: chắc chắn exe sống + lấy kích thước màn theo góc nhìn daemon
    const ping = await this.sendDaemon("PING").catch((e) => { throw new Error(`daemon không khởi động được: ${e.message}`); });
    if (ping.err) throw new Error(ping.err);
    const m = /(\d+)x(\d+)/.exec(ping.extra ?? "");
    if (m && this.monitor) {
      // Nếu DPI/scale khiến daemon thấy khác node-screenshots thì tin daemon
      // (SendInput phải đúng hệ tọa độ daemon nhìn thấy).
      this.monitor = { ...this.monitor, width: Number(m[1]), height: Number(m[2]) };
    }
    return daemon;
  }

  sendDaemon(line, timeoutMs = 2500) {
    const daemon = this.daemon;
    if (!daemon) return Promise.reject(new Error("daemon chưa chạy"));
    const id = String(++this.daemonSeq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        daemon.pending.delete(id);
        resolve({ err: "daemon không hồi đáp (hết giờ)" });
      }, timeoutMs);
      daemon.pending.set(id, { resolve, timer });
      daemon.proc.stdin.write(`${id}|${line}\n`);
    });
  }

  stopDaemon() {
    const daemon = this.daemon;
    if (!daemon) return;
    this.daemon = null;
    try {
      if (daemon.proc.exitCode === null) {
        daemon.proc.stdin.write("0|STOP\n");
        setTimeout(() => {
          try { daemon.proc.kill(); } catch {}
        }, 1500).unref();
      }
    } catch {}
  }

  async compileInputExe() {
    const dir = join(bridgeDataDir(), "screen-input");
    await mkdir(dir, { recursive: true });
    const exe = join(dir, "desktop-input.exe");
    const verFile = join(dir, "desktop-input.ver");
    const source = await readFile(join(__dirname, "desktop-input.cs"), "utf8");
    const digest = sha1(source);

    try {
      const [exeOk, ver] = await Promise.all([access(exe).then(() => true, () => false), readFile(verFile, "utf8").catch(() => "")]);
      if (exeOk && ver.trim() === digest) return exe;
    } catch {}

    const windir = process.env.WINDIR ?? "C:\\Windows";
    const candidates = [
      join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ];
    let csc = null;
    for (const c of candidates) {
      if (await access(c).then(() => true, () => false)) { csc = c; break; }
    }
    if (!csc) {
      this.available = false;
      this.setupError = "Không tìm thấy csc.exe (.NET Framework) — không compile được daemon điều khiển";
      throw new Error(this.setupError);
    }

    const srcCopy = join(dir, "desktop-input.cs");
    await writeFile(srcCopy, source, "utf8");
    try {
      await execFileP(csc, ["/nologo", "/target:exe", "/platform:anycpu", `/out:${exe}`, srcCopy]);
    } catch (error) {
      throw new Error(`Compile daemon lỗi: ${error.message} ${error.stderr ?? ""}`.trim());
    }
    await writeFile(verFile, digest, "utf8");
    return exe;
  }
}
