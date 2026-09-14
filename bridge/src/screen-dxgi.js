// Quản lý daemon desktop-capture.exe (DXGI Desktop Duplication, v4.0) — đường
// chụp màn hình GPU-direct: DWM đã pha khung sẵn, daemon mượn khung đó qua
// duplication, thu nhỏ TRÊN GPU bằng shader, nén JPEG song song 2 thread.
// Giao thức stdout: [4B BE len][1B type][payload] — 0=đứng yên 1=JPEG 2=meta 3=lỗi.
// stdin (dòng): PING | START|<w>|<q> | STOP | KEY | FOCUS|<x>|<y>|<w>|<h> | FOCUSOFF | QUIT
//
// Daemon chết/không khởi tạo được (máy ảo, thiếu GPU driver, RDP) → caller tự
// rơi về đường GDI worker cũ (screen-capture.worker.js) — không gì vỡ.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeDataDir } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export class DxgiCaptureService {
  /**
   * @param handlers {onJpeg, onUnchanged, onMeta, onError} — gọi khi daemon nhả frame.
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.proc = null;
    this.width = 0;
    this.quality = 0;
    this.dims = null; // {width,height} vật lý từ meta daemon
    this.starting = null; // promise bảo đảm 1 lần start
    this.dead = false;
    this.buf = Buffer.alloc(0);
    this.reconfigTimer = null;
  }

  /** Compile exe bằng csc (1 lần, cache theo hash nguồn — giống daemon input). */
  async ensureExe() {
    const dir = join(bridgeDataDir(), "screen-capture");
    await mkdir(dir, { recursive: true });
    const exe = join(dir, "desktop-capture.exe");
    const verFile = join(dir, "desktop-capture.ver");
    const source = await readFile(join(__dirname, "desktop-capture.cs"), "utf8");
    const digest = contentHash(source);
    const [exeOk, ver] = await Promise.all([
      access(exe).then(() => true, () => false),
      readFile(verFile, "utf8").catch(() => ""),
    ]);
    if (exeOk && ver.trim() === digest) return exe;

    const windir = process.env.WINDIR ?? "C:\\Windows";
    const csc = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (!await access(csc).then(() => true, () => false)) {
      throw new Error("Không tìm thấy csc.exe — không compile được daemon chụp");
    }
    await writeFile(join(dir, "desktop-capture.cs"), source, "utf8");
    await execFileP(csc, [
      "/nologo", "/unsafe", "/target:exe", "/platform:anycpu",
      "/r:System.Drawing.dll",
      `/out:${exe}`, join(dir, "desktop-capture.cs"),
    ]);
    await writeFile(verFile, digest, "utf8");
    return exe;
  }

  /** Khởi động daemon + START tham số — resolve khi meta đầu về. */
  async start(width, quality) {
    if (this.starting) return this.starting;
    this.starting = this._start(width, quality);
    return this.starting;
  }

  async _start(width, quality) {
    const exe = await this.ensureExe();
    await this.stop();
    this.dead = false;
    this.width = width;
    this.quality = quality;
    const proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    let buf = "";

    const proc1 = proc;
    proc1.stdout.on("data", (chunk) => this._feed(chunk));
    proc1.stderr.on("data", (c) => { /* stats dòng [stat] — im lặng */ });
    proc1.on("exit", () => {
      if (this.proc === proc1) {
        this.proc = null;
        this.dead = true;
        this.handlers.onError?.("daemon chụp GPU đã thoát");
      }
    });
    proc1.stdin.write(`START|${width}|${quality}\n`);

    // chờ meta (dims) tối đa 8s — trễ hơn là coi như không chạy được
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon chụp GPU không đáp ứng meta")), 8000);
      const onMeta = (meta) => {
        if (!meta || meta.ping) return;
        clearTimeout(timer);
        resolve();
      };
      this._waitMeta = onMeta;
    });
    this._waitMeta = null;
  }

  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[4];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === 1) this.handlers.onJpeg?.(payload);
      else if (type === 0) this.handlers.onUnchanged?.();
      else if (type === 2) {
        let m = null;
        try { m = JSON.parse(payload.toString("utf8")); } catch { m = null; }
        if (m) {
          if (!m.ping && m.screenW) this.dims = { width: m.screenW, height: m.screenH };
          this._waitMeta?.(m);
          if (!m.ping) this.handlers.onMeta?.(m);
        }
      } else if (type === 3) {
        let e = "";
        try { e = JSON.parse(payload.toString("utf8")).message ?? ""; } catch {}
        this._waitMeta?.(null);
        this.handlers.onError?.(e);
      }
    }
  }

  /** Đổi cỡ/quality (zoom v3.0) — debounce vì daemon phải dựng lại texture. */
  reconfigure(width, quality) {
    if (!this.proc || this.dead) return;
    if (width === this.width && quality === this.quality) return;
    clearTimeout(this.reconfigTimer);
    this.reconfigTimer = setTimeout(() => {
      try {
        if (!this.proc || this.dead) return;
        this.width = width;
        this.quality = quality;
        this.proc.stdin.write(`START|${width}|${quality}\n`);
      } catch {}
    }, 500);
    this.reconfigTimer.unref?.();
  }

  /** Xin khung FULL kế tiếp (viewer vừa vào cần nền nguyên khung, đừng chờ keyframe 2s). */
  requestKey() {
    try { this.proc?.stdin.write("KEY\n"); } catch {}
  }

  /**
   * Focus-rect zoom (học 9remote): rect px theo khung chụp hiện hành — daemon
   * chỉ mã hóa vùng đang nhìn. null = tắt, trả về crop vùng-đổi như cũ.
   */
  setFocus(rect) {
    if (!this.proc || this.dead) return;
    try {
      if (rect) {
        this.proc.stdin.write(`FOCUS|${Math.round(rect.x)}|${Math.round(rect.y)}|${Math.round(rect.w)}|${Math.round(rect.h)}\n`);
      } else {
        this.proc.stdin.write("FOCUSOFF\n");
      }
    } catch {}
  }

  async stop() {
    const proc = this.proc;
    this.proc = null;
    this.dead = true;
    this.starting = null;
    clearTimeout(this.reconfigTimer);
    if (!proc) return;
    try { proc.stdin.write("QUIT\n"); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 1500).unref();
    await new Promise((r) => setTimeout(r, 80));
  }
}
