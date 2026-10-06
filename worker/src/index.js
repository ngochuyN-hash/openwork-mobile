// Worker trung chuyển "địa chỉ cố định" — học từ mô hình Edge API của 9Remote.
//
// Multi-tenant ("tòa nhà nhiều phòng"): mỗi bridge chiếm một PHÒNG riêng trên
// KV, ai cũng mở được web nhưng chỉ đụng được máy của phòng mình:
//   - `tenant:<id>`  = {secretHash, name, createdAt} — tài khoản do chủ worker cấp
//     (worker/scripts/tenant.mjs add) hoặc exe desktop tự tạo qua
//     /api/tenant/create — cửa này yêu cầu mã mời (header x-owm-invite) nhúng
//     trong exe lúc build, nên người chỉ biết URL worker không tự mở phòng.
//     KV chỉ
//     giữ sha256 mật khẩu, KHÔNG giữ bản gốc; phòng tạo bởi bản tenant.mjs cũ
//     còn field `secret` plaintext thì vẫn đăng nhập được và được nâng lên
//     secretHash ngay ở lần đăng nhập thành công (xem secretMatches()).
//     Cặp <id>/<secret> dùng ở CẢ HAI đầu:
//     bridge (openpocket edge join) và web (tab Đăng nhập).
//   - `machine:<id>` = {url, updatedAt} — tunnel hiện tại của phòng; khi
//     bridge báo `tunnelDown: true` thì {url: "", tunnelDown, retryAt,
//     updatedAt} = máy sống nhưng đường hầm đang chờ Cloudflare mở lại.
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

// Cờ ALLOW_ROOM_CREATE khóa cửa tạo phòng. Chấp nhận mọi cách viết của "tắt"
// (0/false/no/off — không phân biệt hoa thường, bỏ khoảng trắng thừa) vì
// chủ worker gõ tay trong dashboard Cloudflare, viết "false"/"OFF" là mất ý
// muốn cũng không ai báo. Còn "không đặt" hoặc bất kỳ giá trị khác = MỞ y như
// trước. String() trước để var đặt kiểu SỐ (0) — dashboard có thể trả về số —
// cũng tắt đúng như lời gõ.
const ROOM_CREATE_OFF = new Set(["0", "false", "no", "off"]);
function roomCreateDisabled(env) {
  return ROOM_CREATE_OFF.has(
    String(env.ALLOW_ROOM_CREATE ?? "")
      .trim()
      .toLowerCase()
  );
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// sha256 hex (chữ thường) — dùng để lưu mật khẩu phòng trên KV mà KHÔNG giữ
// bản gốc. Chữ thường, không dấu phân cách để so sánh là chuỗi thuần.
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

// Bản ghi phòng trên KV (key `tenant:<id>`) có HAI shape:
//   {secretHash, name, createdAt} — shape MỚI, chỉ còn sha256 của mật khẩu.
//   {secret,     name, createdAt} — shape CŨ, còn mật khẩu NGUYÊN VĂN do
//     worker/scripts/tenant.mjs (bản cũ) ghi. Chỉ đọc được, không tự sinh ra.
//
// secretMatches() chấp nhận cả hai: có secretHash thì băm secret người dùng
// trình ra rồi so bằng sameSecret (hằng thời gian); không có thì so thẳng
// plaintext như thời trước.
async function secretMatches(record, presented) {
  if (!record || !presented) return false;
  if (record.secretHash) return sameSecret(await sha256Hex(presented), record.secretHash);
  if (record.secret) return sameSecret(presented, record.secret);
  return false;
}

/**
 * Nâng cấp bản ghi cũ {secret} lên {secretHash} sau khi so khớp thành công:
 * đăng nhập được rồi thì không lý do gì để giữ mật khẩu gốc trên KV.
 * Best-effort — hỏng ghi thì vẫn cho đăng nhập (lần sau thử lại), vì nâng
 * cấp là việc dọn dẹp chứ KHÔNG phải điều kiện vào phòng.
 *
 * LỘ TRÌNH bỏ tương thích: xoá nhánh `record.secret` + hàm này KHI
 * worker/scripts/tenant.mjs đã ghi `secretHash` (một bản vá sau này, ngoài
 * phạm vi file này) VÀ mọi phòng tạo bởi bản tenant.mjs cũ đã đăng nhập ít
 * nhất một lần (chính lần đăng nhập đó ghi đè bản ghi). Xoá sớm = khóa cửa
 * các phòng còn mật khẩu gốc trên KV.
 */
async function upgradeTenantRecord(env, tenant, record) {
  if (record?.secretHash || !record?.secret) return false;
  try {
    await env.OWM_STATE.put(
      `tenant:${tenant}`,
      JSON.stringify({
        secretHash: await sha256Hex(record.secret),
        name: record.name ?? tenant,
        createdAt: record.createdAt ?? Date.now(),
      })
    );
    return true;
  } catch (error) {
    console.error(`[worker] tenant: KV upgrade failed for ${tenant}:`, error?.stack ?? String(error));
    return false;
  }
}

// Rate-limit các cửa mở cho người lạ (đăng nhập phòng 10 lần/phút, tự tạo
// phòng 5 lần/phút). Đếm qua Cache API (caches.default) — KHÔNG tốn KV write
// quota; nếu không có cửa này, mỗi lần dò mật khẩu đều đốt 1 KV read (hạn mức
// free 100k/ngày chung cả tòa nhà).
//
// `scope` = phòng đang bị thao tác ("alpha"), để một IP không bị NHÀ NÀO đẩy
// hết lượt của nhà khác: mọi người sau NAT/vpn công ty đều chung 1 IP, còn
// tên phòng thì họ biết trước (nằm trong mọi link QR). Bucket vì thế tách theo
// cả phòng lẫn IP. create-room gọi không truyền scope (lúc tạo chưa có phòng),
// nên vẫn khoá theo IP y như cũ.
//
// `ipLimit` = TẦNG TRẦN THÔ theo IP, chỉ có tác dụng khi `scope` khác rỗng.
// Không có nó thì việc tách bucket theo phòng thành lỗ hổng: tên phòng hợp lệ
// thì ai cũng đoán ra ("zz1".."zz9999"), nên kẻ xấu đổi tên là mỗi tên một
// bucket SẠCH. Cửa pair-tenant không cần token và mỗi lượt tốn 1 KV read, nên
// 1 IP đổi tên liên tục đốt hạn mức 100k/ngày CHUNG cả tòa nhà (dòng trên) tới
// cạn, /__register đọc hụt theo → mọi phòng mất heartbeat và thành offline.
// Trần 10/phút trước vá chặn được vì bucket là của IP; giờ phải cộng tầng thô
// mới giữ được trần đó. 30/phút đủ cho nhà thật dùng chung NAT (3 phòng × 10
// lượt dò) mà vẫn chặn nạn đổi tên phòng.
// Lưu ý: chỉ áp cho cửa tốn KV read (`pair-tenant`). `/api/pair` relay thẳng ra
// tunnel, không đọc KV, và đã có pairLimiter phía bridge làm mũ sắt hai — đặt
// trần thô cho nó sẽ chặn nhà thật sau NAT ghép nhiều máy mà không đổi được
// gì trước KV.
async function rateLimited(request, kind, limit, scope = "", ipLimit = 0) {
  const ip = request.headers.get("cf-connecting-ip") ?? "?";
  const bucket = Math.floor(Date.now() / 60_000);
  const room = scope ? `${encodeURIComponent(scope)}/` : "";
  const key = new Request(`https://owm-ratelimit/${kind}/${room}${encodeURIComponent(ip)}/${bucket}`);
  const hit = await caches.default.match(key);
  const count = hit ? Number(await hit.text()) : 0;

  // Bucket thô: cùng kind nhưng KHÔNG có phần tên phòng. Chỉ dựng khi cả hai
  // điều kiện đúng — có scope (nếu không thì bucket thô TRÙNG bucket phòng, đếm
  // hai lần một lượt và trần thô vô nghĩa) và có ipLimit.
  const rawKey =
    scope && ipLimit > 0
      ? new Request(`https://owm-ratelimit/${kind}-ip/${encodeURIComponent(ip)}/${bucket}`)
      : null;
  const rawHit = rawKey ? await caches.default.match(rawKey) : null;
  const rawCount = rawHit ? Number(await rawHit.text()) : 0;

  if (count >= limit || (rawKey && rawCount >= ipLimit)) return true;

  // TTL 119s cho key bucket cũ tự rác bay khỏi edge cache.
  const put = (k, n) =>
    caches.default.put(
      k,
      new Response(String(n), { headers: { "cache-control": "public, max-age=119" } })
    );
  await put(key, count + 1);
  if (rawKey) await put(rawKey, rawCount + 1);
  return false;
}

/** Ghi slot máy từ /__register: URL tunnel mới, hoặc "máy sống, tunnel đang chết". */
async function storeRegister(env, slotKey, body) {
  const url = String(body?.url ?? "");
  try {
    if (url && TUNNEL_RE.test(url)) {
      await env.OWM_STATE.put(slotKey, JSON.stringify({ url, updatedAt: Date.now() }));
      return json({ ok: true });
    }
    // Heartbeat "hiện diện không URL" từ bridge khi đang chờ Cloudflare hết 429:
    // slot còn tươi (updatedAt mới) nên worker biết máy SỐNG, chỉ đường hầm chết
    // — điện thoại nhận lời nhắn rõ thay vì 503 offline/530 mơ hồ.
    if (body?.tunnelDown === true) {
      await env.OWM_STATE.put(
        slotKey,
        JSON.stringify({ url: "", tunnelDown: true, retryAt: Number(body.retryAt) || 0, updatedAt: Date.now() })
      );
      return json({ ok: true });
    }
    return json({ error: "invalid_url" }, 400);
  } catch (error) {
    console.error(`[worker] register: KV write failed for ${slotKey}:`, error?.stack ?? String(error));
    return json({ error: "kv_write_failed" }, 503);
  }
}

/** Relay request tới slot `slotKey`; bodyJson khác null thì gửi lại body đó. */
async function relay(env, slotKey, request, url, bodyJson = null) {
  let machine = null;
  try {
    machine = JSON.parse((await env.OWM_STATE.get(slotKey)) ?? "null");
  } catch (error) {
    console.error(`[worker] relay: KV read failed for ${slotKey}:`, error?.stack ?? String(error));
    machine = null;
  }
  if (!machine) {
    // Slot biến mất khác máy tắt: nếu cả phòng không còn trên KV (bị dọn dẹp)
    // thì 401 để app về lại màn ghép mã — quét QR là vào lại được, đừng treo
    // vĩnh viễn câu "offline" không có lối ra.
    const tenantId = slotKey.startsWith("machine:") ? slotKey.slice("machine:".length) : "";
    if (tenantId && (await env.OWM_STATE.get(`tenant:${tenantId}`)) === null) {
      return json({ code: "unpaired", message: "This room was deleted - pair again with a new pairing code." }, 401);
    }
    return json(
      { code: "bridge_offline", message: "This room's computer has not registered, or has been offline for over 20 minutes." },
      503
    );
  }
  if (Date.now() - machine.updatedAt > STALE_MS) {
    return json(
      { code: "bridge_offline", message: "This room's computer has not registered, or has been offline for over 20 minutes." },
      503
    );
  }
  // Máy còn heartbeat nhưng đang chờ Cloudflare hết 429 mở lại đường hầm:
  // nói thẳng cho điện thoại thay vì để nó đâm đầu vào URL rỗng.
  if (machine.tunnelDown) {
    const waitMin = machine.retryAt ? Math.max(1, Math.ceil((machine.retryAt - Date.now()) / 60_000)) : null;
    return json(
      {
        code: "tunnel_down",
        message: `The computer is on and the bridge is alive, but Cloudflare is temporarily blocking tunnel creation (429 rate limit). The bridge retries on its own${
          waitMin ? ` (next try in ~${waitMin} min)` : ""
        } - do not restart the bridge, restarting only makes it longer.`,
      },
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
    // Tunnel vừa chết thì Cloudflare edge trả 5xx riêng của nó (520-527/530)
    // kèm trang HTML lỗi thô — gói lại JSON sạch cho điện thoại.
    if ([520, 521, 522, 523, 524, 525, 527, 530].includes(response.status)) {
      return json(
        {
          code: "tunnel_down",
          message: "The tunnel to your computer just broke - the bridge opens a new one within a few minutes and your phone reconnects by itself. Do not restart the bridge.",
        },
        502
      );
    }
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
  } catch (error) {
    console.error(`[worker] relay: fetch ${machine.url}${url.pathname} failed:`, error?.stack ?? String(error));
    return json({ code: "bridge_unreachable", message: "Could not reach the bridge tunnel (address just changed? retry in a few seconds)." }, 502);
  }
}

// Lớp áo giáp thứ hai của web: CSP gắn lên mọi tài nguyên tĩnh — script thì
// tuyệt đối same-origin (không inline), nên nếu một ngày nào đó lọt XSS thì
// code chèn động cũng bị trình duyệt cấm chạy trước khi với tới token trong
// localStorage. blob: cho img vì khung hình stream + preview file là object
// URL; 'unsafe-inline' chỉ cho style — UI xài style attribute dày đặc.
// Thêm script CDN/iframe vào web thì phải nới ở đây.
//
// Cùng bộ áo giáp này còn được gắn ở 2 cửa nữa: bridge tự phục vụ static qua
// tunnel (bridge/src/static.js) và Cloudflare Pages (web/public/_headers).
// Ba bản phải GIỐNG NHAU — web có 2 cửa vào, thiếu header ở cửa nào thì tấm
// chhiến "lọt XSS cũng không chạy được" chỉ còn ở cửa kia. Đổi CSP ở đây thì
// sửa luôn cả hai nơi kia trong cùng một lần.
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
  // nosniff: cấm trình duyệt tự đoán kiểu nội dung — chặn kiểu tấn công "file
  // tĩnh thật ra là HTML/JS", tức làm script chạy được dù CSP có chặt.
  // no-referrer: app không cần referrer ở đâu cả (link ngoài đã rel=noreferrer,
  // link nội bộ là hash-route cùng origin), nên không lộ đường dẫn/token cho
  // bên thứ ba. Giữ nguyên hai dòng này khớp bridge/src/static.js.
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(page.body, { status: page.status, statusText: page.statusText, headers });
}

async function handle(request, env) {
  const url = new URL(request.url);

  // 1. Bridge đăng ký địa chỉ tunnel hiện tại của phòng mình
  if (url.pathname === "/__register" && request.method === "POST") {
    const body = await readJson(request);
    const tenant = String(body?.tenant ?? "").trim().toLowerCase();
    if (tenant) {
      if (!TENANT_RE.test(tenant)) return json({ error: "invalid_tenant" }, 400);
      const record = await env.OWM_STATE.get(`tenant:${tenant}`, "json").catch(() => null);
      if (!(await secretMatches(record, request.headers.get("x-owm-secret")))) {
        return json({ error: "unauthorized" }, 401);
      }
      return storeRegister(env, `machine:${tenant}`, body);
    }
    // Luồng cũ của chủ worker (không tenant): secret môi trường -> machine:main
    if (!env.BRIDGE_SECRET || !(await sameSecret(request.headers.get("x-owm-secret"), env.BRIDGE_SECRET))) {
      return json({ error: "unauthorized" }, 401);
    }
    return storeRegister(env, MAIN_KEY, body);
  }

  // 2. /api/* → relay tới tunnel hiện tại của phòng
  if (url.pathname.startsWith("/api/")) {
    // Đăng nhập web: phòng nằm trong body.user (web chưa có phòng để gửi header).
    // Worker tự so secret TRƯỚC khi relay: phòng lạ và sai mật khẩu cùng một câu
    // 401 — người lạ không dò ra được phòng nào tồn tại (bridge vẫn so lại lần 2).
    if (url.pathname === "/api/pair/tenant" && request.method === "POST") {
      // Phải đọc body TRƯỚC khi gọi rateLimited vì bucket khoá theo CẢ tên
      // phòng lẫn IP. Tên chưa qua TENANT_RE thì đổi tên bucket hoàn toàn (rỗng)
      // — kẻ dò tên phòng đốt lượt của chính mình chứ không của phòng đang
      // tồn tại, vì tên phòng thì ai cũng biết (nằm trong mọi link QR). Lượt rác
      // rơi vào Cache API chứ không tốn KV.
      //
      // Tham số thứ 5 (30) là TRẦN THÔ theo IP, cộng dồn với trần 10/phút của
      // từng phòng. Không có nó thì đổi tên phòng hợp lệ là mỗi tên một bucket
      // sạch, và vì cửa này không cần token + mỗi lượt đọc KV ở dòng dưới,
      // 1 IP đổi "zz1".."zz9999" sẽ đốt hạn mức KV chung của cả tòa nhà tới
      // cạn, kéo /__register theo → mọi phòng mất heartbeat. Chi tiết lý do và
      // vì sao không áp trần này cho /api/pair: xem rateLimited() ở trên.
      const body = await readJson(request);
      const tenant = String(body?.user ?? "").trim().toLowerCase();
      if (await rateLimited(request, "pair-tenant", 10, TENANT_RE.test(tenant) ? tenant : "", 30)) {
        return json({ code: "rate_limited", message: "Too many sign-in attempts - wait about 1 minute and try again." }, 429);
      }
      if (!TENANT_RE.test(tenant)) {
        return json({ code: "invalid_credentials", message: "Wrong login name or password." }, 401);
      }
      const record = await env.OWM_STATE.get(`tenant:${tenant}`, "json").catch(() => null);
      if (!(await secretMatches(record, String(body?.secret ?? "")))) {
        return json({ code: "invalid_credentials", message: "Wrong login name or password." }, 401);
      }
      // Đăng nhập đúng rồi: bản ghi kiểu cũ ({secret} plaintext) được nâng lên
      // {secretHash} ngay tại đây, không cần ai chạy script dọn dẹp.
      await upgradeTenantRecord(env, tenant, record);
      return relay(env, `machine:${tenant}`, request, url, body);
    }

    // Tự tạo phòng (self-serve cho exe của chủ worker): người cài KHÔNG gõ gì —
    // exe tự sinh tên phòng + mật khẩu rồi POST lên đây kèm mã mời nhúng trong
    // exe (header x-owm-invite). Phòng đã tồn tại + ĐÚNG mật khẩu = vào lại
    // bình thường (cài lại máy lần nào cũng thế là xong); sai mật khẩu = 1 câu
    // 401 chung. "main" bị cấm — đó là slot machine:main của chủ worker, nếu
    // cho tạo tenant:main thì bridge lạ đăng ký đè luôn địa chỉ máy nhà.
    // Trần 50 phòng + rate-limit chặn ngập KV nếu URL worker bị lộ.
    if (url.pathname === "/api/tenant/create" && request.method === "POST") {
      // Cửa tạo phòng có thể khóa lại bằng var môi trường ALLOW_ROOM_CREATE.
      // Phòng đã có vẫn đăng nhập/gõ lại mật khẩu bình thường (cờ này chỉ
      // chặn người lạ tự mở phòng mới lấp đầy 50 slot KV).
      if (roomCreateDisabled(env)) {
        return json({ code: "room_create_disabled", message: "Creating new rooms is turned off on this worker - ask the owner for an invite." }, 403);
      }
      if (await rateLimited(request, "create-room", 5)) {
        return json({ code: "rate_limited", message: "Too many rooms created - wait about 1 minute and try again." }, 429);
      }
      // Khóa chính của cửa: mã mời ROOM_CREATE_KEY (secret trên dashboard,
      // KHÔNG nằm trong repo) phải khớp header x-owm-invite mà exe chủ worker
      // nhúng vào lúc build (desktop/invite.key → src/InviteKey.cs). Chưa đặt
      // secret = cửa đóng luôn — an toàn khi quên cấu hình, người lạ chỉ biết
      // URL không mở được phòng. Đặt SAU rate-limit để lượt dò mã vẫn bị đếm.
      const expectedInvite = String(env.ROOM_CREATE_KEY ?? "").trim();
      const gotInvite = (request.headers.get("x-owm-invite") || "").trim();
      if (!expectedInvite || !gotInvite || !(await sameSecret(gotInvite, expectedInvite))) {
        return json(
          {
            code: "invite_required",
            message: expectedInvite
              ? "Only the owner's app build can create rooms here - the invite key was missing or wrong."
              : "This worker has no ROOM_CREATE_KEY configured yet - the owner must set it (dashboard secret) before rooms can be created.",
          },
          403
        );
      }
      const body = await readJson(request);
      const user = String(body?.user ?? "").trim().toLowerCase();
      const secret = String(body?.secret ?? "");
      if (!TENANT_RE.test(user) || ["main", "admin", "root", "api", "www"].includes(user)) {
        return json({ code: "invalid_user", message: "Room name must be 2-32 characters of a-z, 0-9 or dashes." }, 400);
      }
      if (secret.length < 8 || secret.length > 128 || /[\s"':&]/.test(secret)) {
        return json({ code: "invalid_secret", message: "Password must be 8-128 characters with no spaces, quotes, ':' or '&'." }, 400);
      }
      let name = String(body?.name ?? "").replace(/[\r\n"']/g, "").trim().slice(0, 60);
      if (!name) name = user;
      const existing = await env.OWM_STATE.get(`tenant:${user}`, "json").catch(() => null);
      if (existing) {
        if (await secretMatches(existing, secret)) {
          // Gõ lại đúng mật khẩu của phòng đã có = đăng nhập thành công, nên
          // bản ghi kiểu cũ cũng được nâng lên {secretHash} ở đây luôn.
          await upgradeTenantRecord(env, user, existing);
          return json({ ok: true, existed: true, user, name: existing.name || name });
        }
        return json({ code: "taken", message: "That room name is already taken and the password does not match." }, 401);
      }
      let rooms;
      try {
        rooms = await env.OWM_STATE.list({ prefix: "tenant:" });
      } catch (error) {
        console.error("[worker] tenant/create: KV list failed:", error?.stack ?? String(error));
        return json({ code: "kv_error", message: "The worker is busy (KV error) - try again in a few minutes." }, 503);
      }
      if (rooms.keys.length >= 50) {
        return json({ code: "full", message: "No room slots left - contact the worker owner." }, 403);
      }
      await env.OWM_STATE.put(
        `tenant:${user}`,
        JSON.stringify({ secretHash: await sha256Hex(secret), name, createdAt: Date.now() })
      );
      // KV không có CAS nên hai lần tạo cùng tên có thể cùng thấy `existing =
      // null` rồi cùng put — ai ghi sau thắng. Đọc lại sau khi ghi: nếu secret
      // trên KV khác secret mình vừa ghi thì có người đã chen vào giữa lúc,
      // phòng KHÔNG còn của mình. Báo 409 "taken" ngay tại đây thay vì im lặng
      // rồi để bridge của mình đăng ký 401 vô nghĩa về sau. Đây là phát hiện
      // chứ không phải chặn (chốt thật thì cần Durable Object); và vì KV nhất
      // quán theo colo nên cũng có thể chưa thấy bản vừa ghi — nên chỉ kêu
      // "taken" khi đã ĐỌC ĐƯỢC bản ghi và secret nó lệch, không kêu khi đọc
      // hụt (`null`).
      const saved = await env.OWM_STATE.get(`tenant:${user}`, "json").catch(() => null);
      if (saved && !(await secretMatches(saved, secret))) {
        return json({ code: "taken", message: "Another room just took that name - try a different one." }, 409);
      }
      return json({ ok: true, created: true, user, name });
    }

    const tenant = (request.headers.get("x-owm-tenant") || url.searchParams.get("_m") || "")
      .trim()
      .toLowerCase();
    if (tenant && !TENANT_RE.test(tenant)) {
      return json({ code: "bridge_offline", message: "Invalid machine code (room)." }, 503);
    }
    // Ghép thiết bị qua /api/pair: chặn theo IP thật Ở ĐÂY chứ không ở bridge.
    // Mọi request đi qua cloudflared về bridge đều mang 127.0.0.1 nên pairLimiter
    // của bridge chỉ là bucket CHUNG cả tòa nhà — kẻ lạ biết tên phòng (nằm trong
    // mọi link QR) nhét đầy bucket là chủ máy không ghép được máy mới. Ở bridge
    // cũng không sửa được: relay forward header client gửi nguyên vẹn (trừ host)
    // nên `x-forwarded-for` bịa ra là vượt; IP đáng tin duy nhất là
    // `cf-connecting-ip` mà worker thấy. Trần 10/phút — cùng mức pair-tenant,
    // bridge giữ pairLimiter làm mũ sắt thứ hai cho direct-tunnel. Bucket tách
    // theo PHÒNG nữa (scope = tenant): một IP dùng chung cho nhiều nhà (NAT,
    // vpn công ty) thì đoán sai mật khẩu của phòng này không được dùng hết
    // lượt ghép máy của phòng khác.
    // Đứng SAU khi đã tách tenant: request không tenant vẫn phải rơi xuống
    // nhánh tenant_required dưới đây, không bị nuốt vào rate limit.
    if (url.pathname === "/api/pair" && request.method === "POST" && tenant) {
      if (await rateLimited(request, "pair", 10, tenant)) {
        return json({ code: "rate_limited", message: "Too many pairing attempts - wait about 1 minute and try again." }, 429);
      }
    }

    // No room on the bootstrap routes: refuse with a clear error instead of
    // fanning a stranger's code/key out to other people's machines. Every
    // real pairing entry point (QR, master link) carries the room and room
    // sign-in reads body.user, so only stale/roomless links land here.
    if (
      !tenant &&
      ((url.pathname === "/api/pair" && request.method === "POST") ||
        (url.pathname === "/api/state" && request.method === "GET"))
    ) {
      // Only instructions that still exist: the desktop app's QR dialog and
      // the bridge banner both print links that carry &m=<room>. The web
      // sign-in tab is gone, so do not send anyone looking for it.
      return json(
        {
          code: "tenant_required",
          message:
            "Missing room (tenant) - rescan the QR or reopen the FULL pairing/master link from your computer (the link always carries &m=<room>). Links or keys that lost the room cannot get in through the worker.",
        },
        400
      );
    }
    return relay(env, tenant ? `machine:${tenant}` : MAIN_KEY, request, url);
  }

  // 3. Còn lại: static web app (web/dist) qua assets binding
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  // Thin wrapper around handle(): any crash becomes a clean JSON response +
  // console.error — Cloudflare would otherwise serve its HTML 1101 error page,
  // which the app cannot parse. Errors inside handle() bubble up to here.
  async fetch(request, env) {
    let path = "?";
    try {
      path = new URL(request.url).pathname;
    } catch {}
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(`[worker] ${request.method} ${path} failed:`, error?.stack ?? String(error));
      return json({ code: "worker_error", message: "The worker hit an unexpected error - try again in a few minutes." }, 500);
    }
  },
};
