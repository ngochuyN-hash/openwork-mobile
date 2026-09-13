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
import { Worker } from "node:worker_threads";
import { bridgeDataDir } from "./config.js";
import { DxgiCaptureService } from "./screen-dxgi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = platform() === "win32";

const MAX_VIEWERS = 3; // chặn 1 người mở nhiều tab phá CPU
const IDLE_STOP_MS = 0; // hết người xem là dừng chụp + kill daemon NGAY (tick kế tiếp) — đổi lại: viewer quay lại đợi daemon khởi động ~1-2s
// Kiến trúc v3.2: khâu CHỤP chạy trong worker thread riêng (screen-capture.worker.js)
// nên không còn chặn event loop — nhịp dưới là NHỊP CHỤP; việc nén (sharp) chạy
// trên threadpool libuv và pipeline chồng với chụp: throughput = max(chụp, nén).
const CAPTURE_MIN_MS = 25; // hình đang đổi: chụp mỗi 25ms (~40 hình/s trần chụp)
const CAPTURE_IDLE_MS = 80; // màn đứng yên >=8 khung -> giãn nhịp cho đỡ CPU
const CAPTURE_BURST_MS = 15; // sau lệnh điều khiển: chụp liên tục 1.5s — hiệu ứng bấm hiện gần tức thì
const BURST_MS = 1500;
const IDLE_AFTER_STILLS = 8;
const MAX_PENDING_FRAMES = 2; // hàng chờ nén đầy thì vứt khung CŨ — luôn nén khung mới nhất
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
// SHA-256 cho vân tay khung hình + cache exe (không phải mục đích bảo mật,
// chỉ là hàm băm nội dung — OpenSSL SHA-NI đủ nhanh ~10ms/trên 20MB).
function contentHash(buf) {
  return createHash("sha256").update(buf).digest("hex");
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
    this.viewers = new Set();
    this.dimsCache = null; // {width,height} vật lý — cập nhật từ mỗi lần chụp của worker
    this.daemonDims = null; // kích thước theo góc nhìn daemon (DPI) — ưu tiên cho tọa độ input
    this.worker = null; // worker thread chụp màn hình chính (screen-capture.worker.js)
    this.workers = new Set(); // turbo: tối đa 2 workers khi nội dung động (BitBlt GDI ~85-105ms/khung nhưng KHÔNG serialize — đo thật 1.74× với 2 thread)
    this.workerWaiters = []; // resolve khi có cap đầu tiên (ensureReady)
    this.workerStarts = []; // timestamp các lần start — chống vòng restart vô hạn
    this.changedStreak = 0; // chuỗi khung ĐỔI liên tiếp (bật turbo worker)
    this.unchangedStreak = 0; // chuỗi khung đứng yên (tắt turbo, tiết kiệm CPU)
    this.pendingEncode = []; // hàng khung chờ nén, tối đa MAX_PENDING_FRAMES
    this.encodeBusy = false;
    this.encodedHash = null; // hash khung mới nhất ĐÃ nén+gửi
    this.errorStreak = 0;
    this.lastJpegByParams = new Map();
    this.daemon = null; // { proc, pending: Map }
    this.daemonSeq = 0;
    this.idleTimer = null;
    this.dxgi = null; // DxgiCaptureService — đường GPU-direct (ưu tiên)
    this.dxgiFailed = false; // đã thử và chết → khỏi thử lại phiên này, dùng GDI
  }

  dims() {
    return this.dimsCache;
  }

  /** Kích thước cho chuẩn hóa tọa độ input: daemon (DPI-aware) thắng vật lý. */
  inputDims() {
    return this.daemonDims ?? this.dimsCache;
  }

  /**
   * Bảo đảm khâu chụp đã chạy (worker sống + đã có khung đầu tiên để biết kích
   * thước màn). Thay ensureMonitor cũ: monitor giờ nằm trong worker.
   */
  async ensureReady(timeoutMs = 8000) {
    if (!this.available) throw new Error(this.setupError ?? "Chỉ hỗ trợ Windows");
    if (this.dimsCache) return;
    // Ưu tiên đường GPU-direct (desktop-capture.exe): DWM đưa thẳng khung đã pha,
    // thu nhỏ trên GPU, nén JPEG 2 thread song song. Chết/máy ảo/thiếu driver →
    // tự rơi về worker GDI cũ — hành vi v3.2 giữ nguyên.
    if (!this.dxgiFailed) {
      try {
        await this.startDxgi(timeoutMs);
        return;
      } catch (error) {
        this.dxgiFailed = true;
        this.setupError = null;
      }
    }
    this.startWorker();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker chụp màn hình không đáp ứng")), timeoutMs);
      this.workerWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  /** Khởi động DXGI daemon với width = viewer rộng nhất, gắn handlers vào pipeline. */
  async startDxgi(timeoutMs = 8000) {
    let maxW = 0, maxQ = 0;
    for (const v of this.viewers) { if (v.width > maxW) { maxW = v.width; maxQ = v.quality; } }
    if (!maxW) { maxW = 880; maxQ = 55; }
    if (!this.dxgi) {
      this.dxgi = new DxgiCaptureService({
        onJpeg: (jpeg) => this.onDxgiJpeg(jpeg),
        onUnchanged: () => { if (this.viewers.size) this.broadcast(FRAME_UNCHANGED); },
        onMeta: (m) => {
          this.touch();
          const dims = { width: m.screenW, height: m.screenH };
          const changed = !this.dimsCache || this.dimsCache.width !== dims.width || this.dimsCache.height !== dims.height;
          this.dimsCache = dims;
          if (this.workerWaiters.length) for (const r of this.workerWaiters.splice(0)) r();
          if (changed && this.viewers.size) this.broadcastMeta();
        },
        onError: (msg) => {
          // daemon chết giữa phiên: báo + chạy GDI thay ngay
          if (this.viewers.size) {
            this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({ message: `Đường GPU gặp lỗi: ${msg} — chuyển về chụp thường` })));
            this.stopWorker();
            this.dxgiFailed = true;
            this.startWorker();
          }
        },
      });
    }
    await this.dxgi.start(maxW, maxQ);
    if (!this.dimsCache) {
      this.dimsCache = this.dxgi.dims; // meta đã về trong start()
    }
  }

  onDxgiJpeg(jpeg) {
    this.touch();
    const key = `${this.dxgi.width}x${this.dxgi.quality}`;
    // Replay cho viewer mới chỉ nên là khung FULL — replay một crop mảnh từng
    // vẽ mảnh rời lên canvas trống = "màn hình đen" trên phone (14/09).
    if (jpeg.length >= 8) {
      const fx = jpeg.readUInt16LE(0), fy = jpeg.readUInt16LE(2), fw = jpeg.readUInt16LE(4);
      if (fx === 0 && fy === 0 && fw >= this.dxgi.width * 0.95) this.lastJpegByParams.set(key, jpeg);
    }
    if (this.viewers.size) this.broadcast(FRAME_JPEG, jpeg);
    // viewer tham số khác (zoom) vẫn nhận khung này hiển thị co giãn CSS,
    // nhưng tối ưu: nếu viewer muốn width lớn hơn đang chạy → nới daemon
    let maxW = 0, maxQ = 0;
    for (const v of this.viewers) { if (v.width > maxW) { maxW = v.width; maxQ = v.quality; } }
    if (maxW && (maxW > this.dxgi.width || maxQ !== this.dxgi.quality)) {
      this.dxgi.reconfigure(maxW, maxQ);
    }
  }

  startWorker() {
    if (this.workers.size >= 2) return;
    // Chống vòng restart vô hạn (worker chết ngay lập tức): tối đa 3 lần / 10s.
    const now = Date.now();
    this.workerStarts = this.workerStarts.filter((t) => now - t < 10_000);
    if (this.workerStarts.length >= 3) {
      this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({ message: "Worker chụp màn hình chết lặp lại — bỏ thử" })));
      return;
    }
    this.workerStarts.push(now);
    this.pendingEncode = [];
    this.encodedHash = null;
    const worker = new Worker(new URL("./screen-capture.worker.js", import.meta.url), {
      workerData: { minMs: CAPTURE_MIN_MS, idleMs: CAPTURE_IDLE_MS, burstMs: CAPTURE_BURST_MS, idleAfter: IDLE_AFTER_STILLS },
    });
    this.workers.add(worker);
    this.worker = worker;
    worker.on("message", (m) => this.onWorkerMessage(m));
    worker.on("error", (error) => {
      this.setupError = String(error?.message ?? error);
      this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({ message: this.setupError })));
    });
    worker.on("exit", () => {
      this.workers.delete(worker);
      if (this.worker === worker) this.worker = this.workers.size ? [...this.workers][0] : null;
      if (this.viewers.size > 0 && this.viewers.size && this.workers.size === 0) {
        // Worker chính chết giữa phiên xem → dựng lại (turbo nếu cần sẽ tự bật).
        this.startWorker();
      }
    });
  }

  /** Dừng một worker (mặc định con turbo — set còn lại con đầu). */
  stopWorker(one = false) {
    const list = [...this.workers];
    const victims = one && list.length > 1 ? [list[list.length - 1]] : list;
    for (const worker of victims) {
      this.workers.delete(worker);
      if (this.worker === worker) this.worker = this.workers.size ? [...this.workers][0] : null;
      try { worker.postMessage({ cmd: "stop" }); } catch {}
      const w = worker;
      setTimeout(() => { try { void w.terminate(); } catch {} }, 2000).unref();
    }
    if (!one || this.workers.size === 0) {
      this.pendingEncode = [];
      this.encodeBusy = false;
      this.encodedHash = null;
    }
  }

  onWorkerMessage(m) {
    if (m?.t === "cap") {
      this.errorStreak = 0;
      this.touch();
      const dimsChanged = !this.dimsCache || this.dimsCache.width !== m.w || this.dimsCache.height !== m.h;
      this.dimsCache = { width: m.w, height: m.h };
      if (this.workerWaiters.length) for (const r of this.workerWaiters.splice(0)) r();
      if (dimsChanged && this.viewers.size > 0) this.broadcastMeta();
      if (!m.changed) {
        this.changedStreak = 0;
        this.unchangedStreak += 1;
        // Màn tĩnh đủ lâu → ngừng worker turbo (đỡ CPU; worker chính vẫn canh đổi).
        if (this.unchangedStreak >= IDLE_AFTER_STILLS && this.workers.size > 1) this.stopWorker(true);
        // Màn đứng yên: chỉ bắn marker "không đổi" khi hết hàng nén (cosmetic,
        // client dùng để giữ nhịp đếm; khung thật mới quan trọng).
        if (!this.encodeBusy && this.pendingEncode.length === 0) this.broadcast(FRAME_UNCHANGED);
        return;
      }
      this.changedStreak += 1;
      this.unchangedStreak = 0;
      // Nội dung động liên tục → bật worker thứ hai (GDI ~1.74× với 2 thread —
      // đo thật 13/09); ngưỡng 4 để không bật tắt loạn nhịp khi đổi vừa phải.
      if (this.changedStreak >= 4 && this.workers.size < 2 && this.viewers.size > 0) this.startWorker();
      this.pendingEncode.push({ hash: m.hash, raw: m.raw, w: m.w, h: m.h });
      if (this.pendingEncode.length > MAX_PENDING_FRAMES) this.pendingEncode.shift(); // vứt cũ giữ mới
      void this.pumpEncode();
    } else if (m?.t === "err") {
      this.errorStreak += 1;
      if (this.errorStreak === 3) {
        this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({
          message: `Chụp màn hình lỗi: ${m.m} (màn khóa/UAC sẽ như vậy)`,
        })));
      }
    }
  }

  /** Nén khung trong hàng chờ (sharp chạy threadpool — event loop vẫn rảnh). */
  async pumpEncode() {
    if (this.encodeBusy) return;
    this.encodeBusy = true;
    try {
      while (this.pendingEncode.length > 0 && this.viewers.size > 0) {
        const job = this.pendingEncode.shift();
        const groups = new Map();
        for (const v of this.viewers) {
          const key = `${v.width}x${v.quality}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(v);
        }
        if (!groups.size) break;
        const encoded = await Promise.all([...groups.keys()].map(async (key) => {
          const [w, q] = key.split("x").map(Number);
          const { data, info } = await sharp(job.raw, { raw: { width: job.w, height: job.h, channels: 4 } })
            .resize({ width: w, withoutEnlargement: true })
            .jpeg({ quality: q })
            .toBuffer({ resolveWithObject: true });
          // v4.1.1: khung GDI cũng phải mang header [2B x][2B y][2B w][2B h] LE như
          // DXGI — thiếu là pushFrame bên phone cắt mù 8 byte đầu (ăn luôn SOI
          // 0xFF 0xD8 của JPEG) → decode vỡ, canvas trắng dù badge vẫn đếm fps.
          const head = Buffer.alloc(8);
          head.writeUInt16LE(0, 0);
          head.writeUInt16LE(0, 2);
          head.writeUInt16LE(info.width, 4);
          head.writeUInt16LE(info.height, 6);
          return { key, jpeg: Buffer.concat([head, data]) };
        }));
        if (this.workers.size === 0 && this.pendingEncode.length === 0) break; // worker chết — bỏ dở
        this.encodedHash = job.hash;
        for (const { key, jpeg } of encoded) {
          this.lastJpegByParams.set(key, jpeg);
          for (const v of groups.get(key)) this.sendTo(v, FRAME_JPEG, jpeg);
        }
      }
    } catch (error) {
      this.broadcast(FRAME_ERROR, Buffer.from(JSON.stringify({ message: String(error.message ?? error) })));
    } finally {
      this.encodeBusy = false;
      if (this.pendingEncode.length > 0 && this.viewers.size > 0) {
        setImmediate(() => { void this.pumpEncode(); });
      }
    }
  }

  /** Lệnh điều khiển vừa vào → đánh thức mọi worker GDI chụp NGAY ở nhịp burst.
   *  Đường DXGI không cần poke: AcquireNextFrame ngủ tới khi màn ĐỔI — latency
   *  phát hiện thay đổi gần bằng 0 sẵn. */
  poke() {
    if (this.dxgi && this.dxgi.proc) return;
    this.touch();
    const until = Date.now() + BURST_MS;
    this.changedStreak = Math.max(this.changedStreak, 4); // input sắp làm màn đổi — turbo sẵn
    if (this.viewers.size > 0 && this.workers.size < 2) this.startWorker();
    for (const w of this.workers) {
      try { w.postMessage({ cmd: "poke", until }); } catch {}
    }
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
      screenW: this.dimsCache?.width ?? 0,
      screenH: this.dimsCache?.height ?? 0,
      shotW: width, shotH: 0, quality,
    })));
    // Khung gần nhất cùng tham số -> cho xem ngay không phải đợi nhịp chụp
    const key = `${width}x${quality}`;
    if (this.lastJpegByParams.get(key)) this.sendTo(viewer, FRAME_JPEG, this.lastJpegByParams.get(key));
    this.dxgi?.requestKey(); // nền nguyên khung cho người vừa vào (khỏi chờ keyframe 2s)

    void this.ensureReady().catch((e) => {
      this.sendTo(viewer, FRAME_ERROR, Buffer.from(JSON.stringify({ message: String(e.message ?? e) })));
    });
    this.touch();
  }

  /**
   * Viewer qua WebRTC datachannel (đường trực tiếp phone<->PC, không qua HTTP):
   * "screen" chỉ nhận JPEG nhị phân, "control" nhận meta/đứng-yêu/lỗi dạng JSON.
   * Tham số w/q do phone gửi trước bằng hello trên "control".
   */
  addDcViewer(ctl, scr, { w, q }) {
    if (this.viewers.size >= MAX_VIEWERS) {
      try { ctl.sendMessage(JSON.stringify({ t: "err", m: `Tối đa ${MAX_VIEWERS} người xem cùng lúc` })); } catch {}
      return null;
    }
    const viewer = {
      dc: true, ctl, scr,
      width: Math.min(1600, Math.max(320, Math.round(Number(w) || 880))),
      quality: Math.min(85, Math.max(30, Math.round(Number(q) || 55))),
      alive: true,
    };
    this.viewers.add(viewer);
    scr.onClosed(() => this.removeViewer(viewer));
    this.sendTo(viewer, FRAME_META, Buffer.from(JSON.stringify({
      screenW: this.dimsCache?.width ?? 0,
      screenH: this.dimsCache?.height ?? 0,
      shotW: viewer.width, shotH: 0, quality: viewer.quality,
    })));
    const key = `${viewer.width}x${viewer.quality}`;
    if (this.lastJpegByParams.get(key)) this.sendTo(viewer, FRAME_JPEG, this.lastJpegByParams.get(key));
    this.dxgi?.requestKey();
    // Báo lỗi qua control channel — nuốt câm từng làm phone treo spinner mãi
    // không biết bridge đang lạnh (daemon phải compile/spawn lại).
    void this.ensureReady().catch((e) => {
      try { ctl.sendMessage(JSON.stringify({ t: "ierr", m: String(e.message ?? e) })); } catch {}
    });
    this.touch();
    return viewer;
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
      if (viewer.dc) {
        // Datachannel: kiểm tra backlog riêng (SCTP tự kiểm soát lưu lượng, chỉ
        // cần đá viewer chậm quá để khỏi phình buffer), frame = 1 message nhị phân.
        if (viewer.scr.bufferedAmount() > MAX_PENDING_BYTES) {
          viewer.alive = false;
          this.viewers.delete(viewer);
          if (this.viewers.size === 0) this.scheduleIdleStop();
          return;
        }
        if (type === FRAME_JPEG) {
          if (viewer.scr.isOpen()) viewer.scr.sendMessageBinary(payload);
        } else if (type === FRAME_META) {
          viewer.ctl.sendMessage(JSON.stringify({ t: "meta", ...JSON.parse(payload.toString("utf8")) }));
        } else if (type === FRAME_ERROR) {
          viewer.ctl.sendMessage(JSON.stringify({ t: "err", m: JSON.parse(payload.toString("utf8")).message }));
        } else if (type === FRAME_UNCHANGED) {
          viewer.ctl.sendMessage(JSON.stringify({ t: "u" }));
        }
        return;
      }
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

  // (Vòng chụp + poke cũ đã dời vào screen-capture.worker.js — xem onWorkerMessage/pumpEncode.)

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
        this.stopWorker();
        if (this.dxgi) { void this.dxgi.stop(); }
        this.encodedHash = null;
        // XÓA dimsCache: ensureReady coi "đã sẵn sàng" theo cache này — không xóa
        // là daemon đã chết mà viewer kế vẫn tin khâu chụp đang chạy (14/09: mọi
        // lần vào tab sau người đầu tiên chỉ nhận replay crop → màn hình đen).
        this.dimsCache = null;
        // lastJpegByParams GIỮ NGUYÊN: viewer quay lại thấy ngay khung gần nhất
        // trong lúc daemon sống lại, thay vì màn trống chờ compile/chụp (~50-110KB RAM).
      }
    }, IDLE_STOP_MS);
    this.idleTimer.unref();
  }

  async input(body) {
    if (!this.available) throw new Error(this.setupError ?? "Điều khiển chỉ hỗ trợ Windows");
    await this.ensureReady();
    await this.ensureDaemon();
    const line = normalizeInput(body, this.inputDims());
    const reply = await this.sendDaemon(line);
    if (reply.err) throw new Error(reply.err);
    this.poke(); // lệnh vừa ăn -> chụp ngay nhịp kế cho hiệu ứng hiện sớm
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
    if (m) {
      // Nếu DPI/scale khiến daemon thấy khác khung vật lý thì tin daemon cho
      // TỌA ĐỘ INPUT (SendInput đúng hệ tọa độ daemon); meta cho web vẫn vật lý.
      this.daemonDims = { width: Number(m[1]), height: Number(m[2]) };
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
    const digest = contentHash(source);

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
      // System.Windows.Forms chỉ dùng cho Clipboard.SetText (TEXT đi đường clipboard)
      await execFileP(csc, [
        "/nologo", "/target:exe", "/platform:anycpu",
        "/r:System.Windows.Forms.dll",
        `/out:${exe}`, srcCopy,
      ]);
    } catch (error) {
      throw new Error(`Compile daemon lỗi: ${error.message} ${error.stderr ?? ""}`.trim());
    }
    await writeFile(verFile, digest, "utf8");
    return exe;
  }
}
