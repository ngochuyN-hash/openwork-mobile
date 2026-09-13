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

// Rate-limit các cửa mở cho người lạ (đăng nhập phòng 10 lần/phút/IP, tự tạo
// phòng 5 lần/phút/IP). Đếm qua Cache API (caches.default) — KHÔNG tốn KV write
// quota; nếu không có cửa này, mỗi lần dò mật khẩu đều đốt 1 KV read (hạn mức
// free 100k/ngày chung cả tòa nhà).
async function rateLimited(request, kind, limit) {
  const ip = request.headers.get("cf-connecting-ip") ?? "?";
  const bucket = Math.floor(Date.now() / 60_000);
  const key = new Request(`https://owm-ratelimit/${kind}/${encodeURIComponent(ip)}/${bucket}`);
  const hit = await caches.default.match(key);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= limit) return true;
  // TTL 119s cho key bucket cũ tự rác bay khỏi edge cache.
  await caches.default.put(
    key,
    new Response(String(count + 1), { headers: { "cache-control": "public, max-age=119" } })
  );
  return false;
}

/** Relay request tới slot `slotKey`; bodyJson khác null thì gửi lại body đó. */
async function relay(env, slotKey, request, url, bodyJson = null) {
  let machine = null;
  try {
    machine = JSON.parse((await env.OWM_STATE.get(slotKey)) ?? "null");
  } catch {
    machine = null;
  }
  if (!machine) {
    // Slot biến mất khác máy tắt: nếu cả phòng không còn trên KV (bị dọn dẹp)
    // thì 401 để app về lại màn ghép mã — quét QR là vào lại được, đừng treo
    // vĩnh viễn câu "offline" không có lối ra.
    const tenantId = slotKey.startsWith("machine:") ? slotKey.slice("machine:".length) : "";
    if (tenantId && (await env.OWM_STATE.get(`tenant:${tenantId}`)) === null) {
      return json({ code: "unpaired", message: "Phòng này đã bị xóa — ghép lại bằng mã ghép mới." }, 401);
    }
    return json(
      { code: "bridge_offline", message: "Máy tính của phòng này chưa đăng ký hoặc đã offline quá 20 phút." },
      503
    );
  }
  if (Date.now() - machine.updatedAt > STALE_MS) {
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

// Lớp áo giáp thứ hai của web: CSP gắn lên mọi tài nguyên tĩnh — script thì
// tuyệt đối same-origin (không inline), nên nếu một ngày nào đó lọt XSS thì
// code chèn động cũng bị trình duyệt cấm chạy trước khi với tới token trong
// localStorage. blob: cho img vì khung hình stream + preview file là object
// URL; 'unsafe-inline' chỉ cho style — UI xài style attribute dày đặc.
// Thêm script CDN/iframe vào web thì phải nới ở đây.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(page) {
  const headers = new Headers(page.headers);
  headers.set("content-security-policy", CSP);
  return new Response(page.body, { status: page.status, statusText: page.statusText, headers });
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
      // Đăng nhập web: phòng nằm trong body.user (web chưa có phòng để gửi header).
      // Worker tự so secret TRƯỚC khi relay: phòng lạ và sai mật khẩu cùng một câu
      // 401 — người lạ không dò ra được phòng nào tồn tại (bridge vẫn so lại lần 2).
      if (url.pathname === "/api/pair/tenant" && request.method === "POST") {
        if (await rateLimited(request, "pair-tenant", 10)) {
          return json({ code: "rate_limited", message: "Đăng nhập quá nhiều lần — đợi khoảng 1 phút rồi thử lại." }, 429);
        }
        const body = await readJson(request);
        const tenant = String(body?.user ?? "").trim().toLowerCase();
        if (!TENANT_RE.test(tenant)) {
          return json({ code: "invalid_credentials", message: "Sai tên đăng nhập hoặc mật khẩu." }, 401);
        }
        const record = await env.OWM_STATE.get(`tenant:${tenant}`, "json").catch(() => null);
        if (!record?.secret || !(await sameSecret(String(body?.secret ?? ""), record.secret))) {
          return json({ code: "invalid_credentials", message: "Sai tên đăng nhập hoặc mật khẩu." }, 401);
        }
        return relay(env, `machine:${tenant}`, request, url, body);
      }

      // Tự tạo phòng (self-serve): người cài bridge gõ tên phòng + mật khẩu của
      // chính mình là có phòng vĩnh viễn trên KV — không cần chủ worker cấp link
      // mời. Phòng đã tồn tại + ĐÚNG mật khẩu = vào lại bình thường (cài lại máy
      // lần nào cũng gõ lại y như cũ là xong); sai mật khẩu = 1 câu 401 chung.
      // "main" bị cấm — đó là slot machine:main của chủ worker, nếu cho tạo
      // tenant:main thì bridge lạ đăng ký đè luôn địa chỉ máy nhà. Trần 50 phòng
      // + rate-limit chặn ngập KV nếu URL worker bị lộ.
      if (url.pathname === "/api/tenant/create" && request.method === "POST") {
        if (await rateLimited(request, "create-room", 5)) {
          return json({ code: "rate_limited", message: "Tạo phòng quá nhiều lần — đợi khoảng 1 phút rồi thử lại." }, 429);
        }
        const body = await readJson(request);
        const user = String(body?.user ?? "").trim().toLowerCase();
        const secret = String(body?.secret ?? "");
        if (!TENANT_RE.test(user) || ["main", "admin", "root", "api", "www"].includes(user)) {
          return json({ code: "invalid_user", message: "Tên phòng chỉ gồm 2-32 ký tự a-z, 0-9, gạch ngang." }, 400);
        }
        if (secret.length < 8 || secret.length > 128 || /[\s"':&]/.test(secret)) {
          return json({ code: "invalid_secret", message: "Mật khẩu cần 8-128 ký tự, không chứa dấu cách, nháy, ':' hoặc '&'." }, 400);
        }
        let name = String(body?.name ?? "").replace(/[\r\n"']/g, "").trim().slice(0, 60);
        if (!name) name = user;
        const existing = await env.OWM_STATE.get(`tenant:${user}`, "json").catch(() => null);
        if (existing) {
          if (existing.secret && (await sameSecret(secret, existing.secret))) {
            return json({ ok: true, existed: true, user, name: existing.name || name });
          }
          return json({ code: "taken", message: "Tên phòng này đã có người dùng và mật khẩu không khớp." }, 401);
        }
        const rooms = await env.OWM_STATE.list({ prefix: "tenant:" });
        if (rooms.keys.length >= 50) {
          return json({ code: "full", message: "Hết chỗ cho phòng mới — liên hệ chủ worker." }, 403);
        }
        await env.OWM_STATE.put(`tenant:${user}`, JSON.stringify({ secret, name, createdAt: Date.now() }));
        return json({ ok: true, created: true, user, name });
      }

      const tenant = (request.headers.get("x-owm-tenant") || url.searchParams.get("_m") || "")
        .trim()
        .toLowerCase();
      if (tenant && !TENANT_RE.test(tenant)) {
        return json({ code: "bridge_offline", message: "Mã máy (phòng) không hợp lệ." }, 503);
      }
      // Gõ mã ghép tay hay dán khóa trần (owd_/owt_ không kèm phòng) thì web
      // chưa biết phòng nào (chỉ link QR/master mới mang &m=), mà machine:main
      // đã không còn. Dạo qua các phòng còn đăng ký máy, phòng nào nhận mã/khóa
      // thì lấy đáp án của phòng đó — thường chỉ có đúng 1 máy live. Sai ở mọi
      // phòng vẫn về 1 câu 401 của bridge như cũ. /api/state trả edge.tenant
      // nên web đọc luôn phòng từ thân phản hồi.
      const bootstrap =
        (url.pathname === "/api/pair" && request.method === "POST") ||
        (url.pathname === "/api/state" && request.method === "GET");
      if (!tenant && bootstrap) {
        const slots = await env.OWM_STATE.list({ prefix: "machine:" });
        let wrongCode = null;
        let noneOnline = null;
        for (const key of slots.keys.slice(0, 10)) {
          const res = await relay(env, key.name, request, url);
          if (res.ok) return res;
          if (res.status === 401) wrongCode = res;
          else noneOnline = res;
        }
        if (wrongCode) return wrongCode;
        if (noneOnline) return noneOnline;
      }
      return relay(env, tenant ? `machine:${tenant}` : MAIN_KEY, request, url);
    }

    // 3. Còn lại: static web app (web/dist) qua assets binding
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
