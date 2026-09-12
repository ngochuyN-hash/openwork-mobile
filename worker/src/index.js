// Worker trung chuyển "địa chỉ cố định" — học từ mô hình Edge API của 9Remote.
//
// Multi-tenant ("tòa nhà nhiều phòng"): mỗi bridge chiếm một PHÒNG riêng trên
// KV, ai cũng mở được web nhưng chỉ đụng được máy của phòng mình:
//   - `tenant:<id>`  = {secret, name, createdAt} — tài khoản do chủ worker cấp
//     (worker/scripts/tenant.mjs add). Cặp <id>/<secret> dùng ở CẢ HAI đầu:
//     bridge (openpocket edge join) và web (tab Đăng nhập).
//   - `machine:<id>` = {url, updatedAt} — tunnel hiện tại của phòng.
//   - `machine:main` = phòng cũ của chủ worker (không tenant, secret =
//     env BRIDGE_SECRET) — giữ nguyên để máy nhà không phải đổi gì.
//
// Điện thoại chọn phòng qua header `x-owm-tenant` (hoặc ?_m= cho
// EventSource không set được header). Riêng /api/pair/tenant đọc phòng từ
// body.user (web chưa lưu phòng lúc đăng nhập). Mọi request /api/* được relay
// thẳng tới tunnel của phòng (kèm header auth nguyên vẹn — khóa vẫn do bridge
// kiểm tra, worker KHÔNG giữ khóa của ai cả). Static phục vụ từ web/dist.

const MAIN_KEY = "machine:main";
const STALE_MS = 20 * 60 * 1000; // bridge heartbeat 15 phút/lần — quá 20 phút coi như offline
const TENANT_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// So secret lệch độ dài trả false ngay, cùng độ dài thì so hằng thời gian
// (crypto.subtle.timingSafeEqual là mở rộng riêng của runtime Workers).
async function sameSecret(presented, expected) {
  if (!presented || !expected) return false;
  const a = new TextEncoder().encode(String(presented));
  const b = new TextEncoder().encode(String(expected));
  if (a.byteLength !== b.byteLength) return false;
  try {
    if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  } catch {}
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readJson(request) {
  return request.json().catch(() => null);
}

/** Relay request tới slot `slotKey`; bodyJson khác null thì gửi lại body đó. */
async function relay(env, slotKey, request, url, bodyJson = null) {
  let machine = null;
  try {
    machine = JSON.parse((await env.OWM_STATE.get(slotKey)) ?? "null");
  } catch {
    machine = null;
  }
  if (!machine || Date.now() - machine.updatedAt > STALE_MS) {
    return json(
      { code: "bridge_offline", message: "Máy tính của phòng này chưa đăng ký hoặc đã offline quá 20 phút." },
      503
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  // Xin không nén ở chân subrequest: edge của tunnel hay tự nén gzip, làm
  // client không xin gzip nhận phải body nén + header content-encoding sai.
  headers.set("accept-encoding", "identity");
  const init = { method: request.method, headers, redirect: "manual" };
  if (bodyJson !== null) {
    init.body = JSON.stringify(bodyJson);
  } else if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }
  try {
    const response = await fetch(machine.url + url.pathname + url.search, init);
    let body = response.body;
    const out = new Headers(response.headers);
    // Phòng hờ: nếu response vẫn bị nén dù đã xin identity, giải nén tại chỗ
    // và gỡ header — client luôn nhận byte thô, đúng như bridge trả ra.
    const enc = String(out.get("content-encoding") ?? "").trim().toLowerCase();
    if (body && (enc === "gzip" || enc === "deflate")) {
      body = body.pipeThrough(new DecompressionStream(enc));
      out.delete("content-encoding");
      out.delete("content-length");
    }
    const result = new Response(body, { status: response.status, statusText: response.statusText, headers: out });
    result.headers.set("cache-control", "no-store");
    return result;
  } catch {
    return json({ code: "bridge_unreachable", message: "Không nối được tunnel của bridge (vừa đổi địa chỉ? thử lại vài giây)." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Bridge đăng ký địa chỉ tunnel hiện tại của phòng mình
    if (url.pathname === "/__register" && request.method === "POST") {
      const body = await readJson(request);
      const tenant = String(body?.tenant ?? "").trim().toLowerCase();
      if (tenant) {
        if (!TENANT_RE.test(tenant)) return json({ error: "invalid_tenant" }, 400);
        const record = await env.OWM_STATE.get(`tenant:${tenant}`, "json").catch(() => null);
        if (!record?.secret || !(await sameSecret(request.headers.get("x-owm-secret"), record.secret))) {
          return json({ error: "unauthorized" }, 401);
        }
        if (!body?.url || !TUNNEL_RE.test(String(body.url))) return json({ error: "invalid_url" }, 400);
        await env.OWM_STATE.put(
          `machine:${tenant}`,
          JSON.stringify({ url: String(body.url), updatedAt: Date.now() })
        );
        return json({ ok: true });
      }
      // Luồng cũ của chủ worker (không tenant): secret môi trường -> machine:main
      if (!env.BRIDGE_SECRET || !(await sameSecret(request.headers.get("x-owm-secret"), env.BRIDGE_SECRET))) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!body?.url || !TUNNEL_RE.test(String(body.url))) return json({ error: "invalid_url" }, 400);
      await env.OWM_STATE.put(MAIN_KEY, JSON.stringify({ url: String(body.url), updatedAt: Date.now() }));
      return json({ ok: true });
    }

    // 2. /api/* → relay tới tunnel hiện tại của phòng
    if (url.pathname.startsWith("/api/")) {
      // Đăng nhập web: phòng nằm trong body.user (web chưa có phòng để gửi header)
      if (url.pathname === "/api/pair/tenant" && request.method === "POST") {
        const body = await readJson(request);
        const tenant = String(body?.user ?? "").trim().toLowerCase();
        if (!TENANT_RE.test(tenant)) {
          return json({ code: "invalid_credentials", message: "Sai tên đăng nhập hoặc mật khẩu." }, 401);
        }
        return relay(env, `machine:${tenant}`, request, url, body);
      }

      const tenant = (request.headers.get("x-owm-tenant") || url.searchParams.get("_m") || "")
        .trim()
        .toLowerCase();
      if (tenant && !TENANT_RE.test(tenant)) {
        return json({ code: "bridge_offline", message: "Mã máy (phòng) không hợp lệ." }, 503);
      }
      return relay(env, tenant ? `machine:${tenant}` : MAIN_KEY, request, url);
    }

    // 3. Còn lại: static web app (web/dist) qua assets binding
    return env.ASSETS.fetch(request);
  },
};
