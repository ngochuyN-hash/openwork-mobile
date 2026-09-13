// Worker thread CHỤP màn hình — tách BitBlt GDI (đồng bộ, chặn 20-45ms mỗi
// khung) khỏi event loop của bridge để:
//   1) nhịp chụp không bị HTTP/datachannel chen ngang làm chậm (fps ổn định),
//   2) ping trên datachannel trung thực (không còn spike khi đang chụp),
//   3) pipeline: chụp khung N+1 ngay trong lúc threadpool của sharp còn đang
//      nén khung N — throughput = max(chụp, nén) thay vì tổng chuỗi.
// Hash BMP (chép thuần ~12ms) thay vì hash raw (swizzle BGRA->RGBA 55-104ms —
// thủ phạm cũ rơi fps); raw chỉ materialize (~2ms) khi hình THẬT SỰ đổi.
// Nếu event loop bridge chết thực sự (keep-alive không hồi), worker tự thoát.
import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

// Nạp native addon bằng require thường trong worker (NAPI đăng ký theo isolate
// — đã chạy thử thật trên máy nhà 13/09, chụp 2880x1800 đủ bmp+raw).
const require = createRequire(import.meta.url);
const mod = require("node-screenshots");
const Monitor = mod.Monitor ?? mod.default?.Monitor;

const port = parentPort;
const MIN_MS = workerData?.minMs ?? 25; // nhịp khi hình đang đổi
const IDLE_MS = workerData?.idleMs ?? 80; // màn đứng yên lâu → giãn nhịp đỡ CPU
const BURST_PACE_MS = workerData?.burstMs ?? 15; // sau lệnh điều khiển: chụp liên tục
const IDLE_AFTER = workerData?.idleAfter ?? 8; // sau N khung đứng yên liên tiếp

let monitor = null;
let lastHash = null; // trạng thái hash giữ TẠI worker — chỉ báo "đổi" khi thật
let running = true;
let burstUntil = 0;
let wake = null;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

async function main() {
  let stillStreak = 0;
  while (running) {
    const t0 = Date.now();
    try {
      if (!monitor) {
        const all = Monitor.all() ?? [];
        monitor = all.find((m) => m.isPrimary?.()) ?? all[0];
        if (!monitor) throw new Error("Không tìm thấy màn hình nào");
      }
      const img = monitor.captureImageSync();
      const bmp = img.toBmpSync();
      const hash = createHash("sha256").update(bmp).digest("hex");
      if (hash === lastHash) {
        stillStreak += 1;
        port.postMessage({ t: "cap", changed: false, w: img.width, h: img.height });
      } else {
        lastHash = hash;
        stillStreak = 0;
        const view = img.toRawSync(); // RGBA — sau BMP chỉ ~2ms (đã materialize)
        // Buffer native ngoài (external ArrayBuffer) KHÔNG transfer được qua
        // postMessage ("Cannot transfer object of unsupported type" — dính
        // thật 13/09) → luôn chép sang Buffer tự cấp: memcpy ~5ms trong worker,
        // ngoài event loop, và ArrayBuffer thường chuyển zero-copy sang main.
        const raw = Buffer.allocUnsafe(view.byteLength);
        view.copy(raw);
        port.postMessage({ t: "cap", changed: true, hash, w: img.width, h: img.height, raw }, [raw.buffer]);
      }
    } catch (error) {
      port.postMessage({ t: "err", m: String(error?.message ?? error) });
      monitor = null; // lỗi capture (đổi resolution/màn khóa) → dò lại lần sau
      await sleep(1000);
      continue;
    }
    const pace = Date.now() < burstUntil ? BURST_PACE_MS : (stillStreak >= IDLE_AFTER ? IDLE_MS : MIN_MS);
    await sleep(Math.max(3, pace - (Date.now() - t0)));
  }
}

port.on("message", (m) => {
  if (m?.cmd === "poke") burstUntil = Math.max(burstUntil, m.until ?? 0);
  else if (m?.cmd === "stop") { running = false; wake?.(); }
});
// Bridge chết bất tử mà quên gửi stop → ticker này giữ cho process không treo
// vô hạn: cha mất thì worker phải tự kết thúc (unref cho phép exit tự nhiên).
const adopt = setInterval(() => {}, 60000);
adopt.unref?.();

main().catch((error) => {
  try { port.postMessage({ t: "err", m: String(error?.message ?? error) }); } catch {}
  process.exit(1);
});
