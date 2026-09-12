// Đăng ký địa chỉ tunnel hiện tại lên Cloudflare Worker (địa chỉ cố định).
// Bridge gọi module này khi có lookupUrl + lookupSecret trong config:
//   - tunnel đổi URL -> đăng ký lại NGAY
//   - mỗi 15 phút đăng ký lại giữ ấm (worker coi >20 phút là offline; thưa vậy
//     để đỡ tốn hạn mức ghi KV free — ~96 ghi/ngày/phòng, đủ ~10 phòng)
// Có lookupTenant thì đăng ký vào "phòng" riêng (multi-tenant) kèm trong body.
import { randomBytes } from "node:crypto";

export const HEARTBEAT_MS = 15 * 60 * 1000;

export function newLookupSecret() {
  return `owls_${randomBytes(24).toString("hex")}`;
}

export function startLookup({
  getUrl,
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
  const tenantKey = String(tenant ?? "").trim().toLowerCase();

  async function register() {
    const url = getUrl();
    if (!url) return;
    try {
      const response = await fetchImpl(`${workerUrl.replace(/\/+$/, "")}/__register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owm-secret": secret },
        body: JSON.stringify(tenantKey ? { url, tenant: tenantKey } : { url }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        if (url !== lastSent) log(`[lookup] đã đăng ký địa chỉ mới${tenantKey ? ` (phòng ${tenantKey})` : ""}: ${url}`);
        lastSent = url;
        lastOkAt = now();
      } else {
        log(`[lookup] đăng ký lỗi HTTP ${response.status}`);
      }
    } catch (error) {
      log(`[lookup] không đăng ký được: ${error.message}`);
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    const url = getUrl();
    if (!url) return;
    if (url !== lastSent || now() - lastOkAt > heartbeatMs) register();
  }, tickMs);
  timer.unref?.();
  register(); // chạy luôn một lần khi khởi động

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
