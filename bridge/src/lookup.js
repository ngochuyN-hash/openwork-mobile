// Đăng ký địa chỉ tunnel hiện tại lên Cloudflare Worker (địa chỉ cố định).
// Bridge gọi module này khi có lookupUrl + lookupSecret trong config:
//   - tunnel đổi URL -> đăng ký lại NGAY
//   - mỗi 60s đăng ký lại giữ ấm (worker coi >10 phút không heartbeat là offline)
import { randomBytes } from "node:crypto";

export function newLookupSecret() {
  return `owls_${randomBytes(24).toString("hex")}`;
}

export function startLookup({ getUrl, workerUrl, secret, log = console.log }) {
  let lastSent = "";
  let lastOkAt = 0;
  let stopped = false;

  async function register() {
    const url = getUrl();
    if (!url) return;
    try {
      const response = await fetch(`${workerUrl.replace(/\/+$/, "")}/__register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owm-secret": secret },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        if (url !== lastSent) log(`[lookup] đã đăng ký địa chỉ mới: ${url}`);
        lastSent = url;
        lastOkAt = Date.now();
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
    if (url !== lastSent || Date.now() - lastOkAt > 60_000) register();
  }, 15_000);
  timer.unref();
  register(); // chạy luôn một lần khi khởi động

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
