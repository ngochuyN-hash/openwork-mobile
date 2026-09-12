// Worker trung chuyển "địa chỉ cố định" — học từ mô hình Edge API của 9Remote.
//
// Bridge trên máy nhà tự đăng ký địa chỉ tunnel HIỆN TẠI (đổi liên tục) lên đây
// qua /__register (chống giả bằng secret riêng). Điện thoại chỉ cần biết ĐÚNG
// MỘT địa chỉ cố định: worker này. Mọi request /api/* được trung chuyển thẳng
// tới tunnel hiện tại (kèm header auth nguyên vẹn — key vẫn do bridge kiểm tra,
// worker KHÔNG giữ key của ai cả). Static (web app) phục vụ từ web/dist.

const MACHINE_KEY = "machine:main";
const STALE_MS = 10 * 60 * 1000; // bridge không heartbeat 10 phút = coi như offline

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Bridge đăng ký địa chỉ tunnel hiện tại
    if (url.pathname === "/__register" && request.method === "POST") {
      if (!env.BRIDGE_SECRET || request.headers.get("x-owm-secret") !== env.BRIDGE_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json().catch(() => null);
      if (!body?.url || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(String(body.url))) {
        return json({ error: "invalid_url" }, 400);
      }
      await env.OWM_STATE.put(MACHINE_KEY, JSON.stringify({ url: String(body.url), updatedAt: Date.now() }));
      return json({ ok: true });
    }

    // 2. /api/* → relay tới tunnel hiện tại của bridge (stream giữ nguyên cho SSE)
    if (url.pathname.startsWith("/api/")) {
      let machine = null;
      try {
        machine = JSON.parse((await env.OWM_STATE.get(MACHINE_KEY)) ?? "null");
      } catch {
        machine = null;
      }
      if (!machine || Date.now() - machine.updatedAt > STALE_MS) {
        return json(
          { code: "bridge_offline", message: "Bridge trên máy tính chưa đăng ký hoặc đã offline quá 10 phút." },
          503
        );
      }

      const headers = new Headers(request.headers);
      headers.delete("host");
      const init = { method: request.method, headers, redirect: "manual" };
      if (!["GET", "HEAD"].includes(request.method)) {
        init.body = await request.arrayBuffer();
      }
      try {
        const response = await fetch(machine.url + url.pathname + url.search, init);
        const out = new Response(response.body, response);
        out.headers.set("cache-control", "no-store");
        return out;
      } catch {
        return json({ code: "bridge_unreachable", message: "Không nối được tunnel của bridge (vừa đổi địa chỉ? thử lại vài giây)." }, 502);
      }
    }

    // 3. Còn lại: static web app (web/dist) qua assets binding
    return env.ASSETS.fetch(request);
  },
};
