// Đăng ký địa chỉ tunnel hiện tại lên Cloudflare Worker (địa chỉ cố định).
// Bridge gọi module này khi có lookupUrl + lookupSecret trong config:
//   - tunnel đổi URL -> đăng ký lại NGAY
//   - mỗi 15 phút đăng ký lại giữ ấm (worker coi >20 phút là offline; thưa vậy
//     để đỡ tốn hạn mức ghi KV free — ~96 ghi/ngày/phòng, đủ ~10 phòng)
//   - tunnel đang chết (đang chờ Cloudflare hết 429): báo "hiện diện KHÔNG URL"
//     ({tunnelDown: true, retryAt}) khi TRẠNG THÁI ĐỔI + nhịp giữ ấm — worker
//     và điện thoại phân biệt được "máy sống, hầm đang chết" với "máy offline",
//     thay vì nhét trang lỗi 530 thô của Cloudflare vào mặt người dùng.
// Có lookupTenant thì đăng ký vào "phòng" riêng (multi-tenant) kèm trong body.
// Worker từ chối (401/400) thì backoff luỹ thừa, chỉ log 1 dòng rõ ràng —
// trước đây config lệch phòng là hét 401 mỗi 15 giây cả trăm dòng (13/09).
import { randomBytes } from "node:crypto";

export const HEARTBEAT_MS = 15 * 60 * 1000;
const AUTH_BACKOFF_BASE_MS = 15_000;
const AUTH_BACKOFF_MAX_MS = 5 * 60_000;

export function newLookupSecret() {
  return `owls_${randomBytes(24).toString("hex")}`;
}

export function startLookup({
  getUrl,
  getState = null, // () => {phase, url, streak, nextRetryAt} từ tunnel.js — null = hành vi cũ
  workerUrl,
  secret,
  tenant = "",
  log = console.log,
  tickMs = 15_000,
  heartbeatMs = HEARTBEAT_MS,
  fetchImpl = fetch,
  now = Date.now,
}) {
  let lastSent = "";
  let lastOkAt = 0;
  let stopped = false;
  let blockedUntil = 0; // backoff sau 401/400
  let failStreak = 0;
  let lastFailStatus = 0;
  let lastDownKey = ""; // pha "tunnel chết" đã gửi gần nhất (bucket theo heartbeatMs)
  const tenantKey = String(tenant ?? "").trim().toLowerCase();

  function noteAuthFailure(status) {
    failStreak += 1;
    const delay = Math.min(AUTH_BACKOFF_BASE_MS * 2 ** (failStreak - 1), AUTH_BACKOFF_MAX_MS);
    blockedUntil = now() + delay;
    if (failStreak === 1 || status !== lastFailStatus) {
      log(
        `[lookup] worker rejected the registration (HTTP ${status}) - wrong room/password? Check that lookupTenant + lookupSecret in config match the KV worker. Pausing ${Math.round(
          delay / 1000
        )}s before retrying.`
      );
    }
    lastFailStatus = status;
  }

  async function register(payload) {
    if (now() < blockedUntil) return;
    try {
      const response = await fetchImpl(`${workerUrl.replace(/\/+$/, "")}/__register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owm-secret": secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        failStreak = 0;
        lastFailStatus = 0;
        lastOkAt = now();
        if (payload.tunnelDown) {
          const key = `down:${Math.round((Number(payload.retryAt) || 0) / heartbeatMs)}`;
          if (key !== lastDownKey) {
            log("[lookup] told the worker: machine alive, tunnel is waiting for Cloudflare to reopen (bridge retries on a schedule).");
          }
          lastSent = ""; // tunnel sống lại sẽ đăng ký lại URL ngay, kể URL cũ
          lastDownKey = key;
        } else {
          if (payload.url !== lastSent) {
            log(`[lookup] registered a new address${tenantKey ? ` (room ${tenantKey})` : ""}: ${payload.url}`);
          }
          lastSent = payload.url;
          lastDownKey = "";
        }
      } else {
        noteAuthFailure(response.status);
      }
    } catch (error) {
      log(`[lookup] could not register: ${error.message}`);
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    const url = getUrl();
    const tunnel = getState ? getState() : null;
    // URL có thật + tunnel.js xác nhận "up" mới đăng ký giữ ấm bình thường.
    // KHÔNG tin getUrl() một mình: cloudflared chết giữa chừng thì URL cũ vẫn
    // kẹt trong biến — giữ ấm URL chết khiến worker cứ tưởng máy online (13/09).
    if (url && (!tunnel || tunnel.phase === "up")) {
      if (url !== lastSent || now() - lastOkAt > heartbeatMs) {
        register(tenantKey ? { url, tenant: tenantKey } : { url });
      }
      return;
    }
    // Tunnel không "up" (đang backoff chờ Cloudflare, hoặc mới start chưa có
    // URL): báo "máy sống, hầm chết" theo trạng thái đổi + nhịp giữ ấm.
    if (tunnel && tunnel.phase !== "up") {
      const retryAt = Number(tunnel.nextRetryAt) || 0;
      const key = `down:${Math.round(retryAt / heartbeatMs)}`;
      if ((key !== lastDownKey || now() - lastOkAt > heartbeatMs) && now() >= blockedUntil) {
        register(
          tenantKey ? { url: "", tunnelDown: true, retryAt, tenant: tenantKey } : { url: "", tunnelDown: true, retryAt }
        );
      }
    }
  }, tickMs);
  timer.unref?.();
  const bootUrl = getUrl(); // chạy luôn một lần khi khởi động (chỉ khi đã có URL)
  if (bootUrl) register(tenantKey ? { url: bootUrl, tenant: tenantKey } : { url: bootUrl });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
