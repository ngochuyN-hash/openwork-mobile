// Test relay của worker/src/index.js — chạy thuần Node >= 22 (module syntax
// detection cho phép import thẳng file .js kiểu ESM), KHÔNG đụng mạng thật:
//   - global fetch bị thay bằng mock ghi lại mọi lần gọi (url/method/headers/body)
//   - env.OWM_STATE là KV giả trong bộ nhớ (get/put/list đủ cho worker)
//   - caches.default (Cache API của runtime Workers, dùng cho rate-limit) được
//     stub vì Node không có — không stub thì rateLimited ném TypeError.
// Chạy: node --test worker/test/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const worker = (await import("../src/index.js")).default;

// sha256 hex chữ thường — đúng thứ worker/src/index.js băm mật khẩu trước khi
// lưu KV. Tính LẠI ở đây (không import helper của worker) để test không trở
// thành bản sao của implementation: cùng thuật toán, hai chỗ viết độc lập.
const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

// Node test env lacks the Workers Cache API — stub caches.default so
// rateLimited() works (every miss = not limited).
if (!globalThis.caches?.default) {
  globalThis.caches = {
    ...globalThis.caches,
    default: { match: async () => undefined, put: async () => {} },
  };
}

// ---------- Mock hạ tầng ----------

/** KV giả: trả key theo thứ tự từ điển như KV thật, ghi lại mọi key đã đọc. */
function mockKV(seed = {}) {
  const map = new Map(Object.entries(seed));
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    async get(key, type) {
      reads.push(key);
      const raw = map.get(key);
      if (raw == null) return null;
      if (type === "json") {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    async put(key, value) {
      writes.push({ key, value: String(value) });
      map.set(key, String(value));
    },
    async list({ prefix = "" } = {}) {
      const keys = [...map.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/** Cài fetch giả toàn cục; mỗi lần worker gọi fetch được ghi vào calls. */
function mockFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    calls.push({ url: String(input), init, headers });
    return handler(String(input), init, headers);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

/**
 * Cache API giả CÓ BỘ ĐẾM THẬT. Stub ở đầu file luôn miss nên rateLimited()
 * không bao giờ trả true — muốn test 429 thì phải đếm thật theo key.
 * `count(kind, ip, scope)` cộng dồn mọi bucket phút của một cặp kind/scope/IP;
 * bỏ scope = đúng cách gọi không truyền scope (cửa create-room).
 */
function countingCache() {
  const store = new Map();
  return {
    default: {
      async match(key) {
        const hit = store.get(key.url);
        return hit === undefined ? undefined : new Response(hit);
      },
      async put(key, value) {
        store.set(key.url, await value.text());
      },
    },
    count(kind, ip, scope = "") {
      const room = scope ? `${encodeURIComponent(scope)}/` : "";
      const prefix = `https://owm-ratelimit/${kind}/${room}${encodeURIComponent(ip)}/`;
      let sum = 0;
      for (const [url, value] of store) if (url.startsWith(prefix)) sum += Number(value);
      return sum;
    },
    urls() {
      return [...store.keys()];
    },
  };
}

/**
 * Cài caches.default có trạng thái trong phạm vi đúng một test rồi trả về y hệt
 * — caches là global nên bắt buộc khôi phục, không ôm bẩn các test khác.
 */
function useCountingCache(t) {
  const cache = countingCache();
  const real = globalThis.caches;
  globalThis.caches = { ...real, default: cache.default };
  t.after(() => (globalThis.caches = real));
  return cache;
}

const jsonRes = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

// Slot machine: còn sống (heartbeat mới, URL tunnel hợp lệ)
const slot = (url) => JSON.stringify({ url, updatedAt: Date.now() });

/** Request /api/* giống app thật: JSON body + content-type. */
function apiRequest(path, { method = "POST", body, headers = {} } = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (method !== "GET" && body !== undefined) init.body = body;
  return new Request(`https://worker.test${path}`, init);
}

// Body relay có thể là string (bootstrap) hoặc ArrayBuffer (relay nguyên bản)
const bodyOf = (call) => {
  const b = call.init.body;
  if (typeof b === "string") return b;
  if (b == null) return "";
  return new TextDecoder().decode(b);
};

// ---------- Các kịch bản ----------

test("bootstrap /api/pair: không tenant → 400 tenant_required, KHÔNG đụng máy của phòng khác", async (t) => {
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "machine:beta": slot("https://beta.trycloudflare.com"),
  });
  const { calls, restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/pair", { body: '{"code":"owd_x"}' }), {
    OWM_STATE: kv,
  });

  assert.equal(res.status, 400);
  const payload = await res.json();
  assert.equal(payload.code, "tenant_required");
  assert.ok(payload.message.length > 10);
  // Chặn ngay từ cổng: không relay đi máy nào, không đốt lượt đọc KV
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
});

test("bootstrap /api/pair: không tenant → kể cả machine:main tồn tại vẫn bị chặn, không fallback", async (t) => {
  const kv = mockKV({
    "machine:main": slot("https://main.trycloudflare.com"),
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
  });
  const { calls, restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/pair", { body: '{"code":"owd_x"}' }), {
    OWM_STATE: kv,
  });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "tenant_required");
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
});

test("bootstrap GET /api/state: không tenant → 400 tenant_required, không quét slot", async (t) => {
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/state", { method: "GET" }), { OWM_STATE: kv });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "tenant_required");
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
});

test("bootstrap /api/pair: body JSON hỏng + không tenant → vẫn tenant_required, không relay", async (t) => {
  const kv = mockKV();
  const { calls, restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  for (const bad of ["{không phải json", "[]", '"chuỗi"', "5"]) {
    const res = await worker.fetch(apiRequest("/api/pair", { body: bad }), { OWM_STATE: kv });
    assert.equal(res.status, 400, `body ${JSON.stringify(bad)} phải trả 400`);
    assert.equal((await res.json()).code, "tenant_required");
  }
  // Body không còn được đọc/relay đi đâu — chặn ngay ở cửa thiếu phòng
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
});

test("route thường (không phải bootstrap) không tenant → vẫn relay về machine:main như luồng cũ", async (t) => {
  const kv = mockKV({ "machine:main": slot("https://main.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true, devices: [] }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/devices", { method: "GET" }), { OWM_STATE: kv });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, devices: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://main.trycloudflare.com/api/devices");
  assert.equal(calls[0].init.method, "GET");
});

test("request có x-owm-tenant → relay đúng 1 lần tới phòng đó, không quét slot khác", async (t) => {
  const kv = mockKV({
    "machine:myroom": slot("https://myroom.trycloudflare.com"),
    "machine:other": slot("https://other.trycloudflare.com"),
  });
  const { calls, restore } = mockFetch((url) =>
    url.startsWith("https://myroom.trycloudflare.com/")
      ? jsonRes(200, { ok: true, room: "myroom" })
      : jsonRes(500, { unexpected: url })
  );
  t.after(restore);

  const raw = JSON.stringify({ ping: 1 });
  const res = await worker.fetch(
    apiRequest("/api/pair", { body: raw, headers: { "x-owm-tenant": "MyRoom" } }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, room: "myroom" });
  // Đúng 1 lần, đúng phòng (header chuẩn hóa "MyRoom" -> machine:myroom)
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://myroom.trycloudflare.com/api/pair");
  // Body gốc đi nguyên văn (relay không parse lại khi đã chỉ định phòng)
  assert.equal(bodyOf(calls[0]), raw);
  assert.equal(calls[0].headers.get("x-owm-tenant"), "MyRoom");
  assert.equal(calls[0].headers.get("accept-encoding"), "identity");
  assert.equal(calls[0].headers.get("host"), null);
});

test("GET /api/state: có tenant (header) → relay đúng 1 lần, GET không mang body", async (t) => {
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { edge: { tenant: "alpha", online: true } }));
  t.after(restore);

  const res = await worker.fetch(
    apiRequest("/api/state", { method: "GET", headers: { "x-owm-tenant": "alpha" } }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { edge: { tenant: "alpha", online: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://alpha.trycloudflare.com/api/state");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined); // GET không mang body
});

test("relay: tunnel không nối được (fetch ném lỗi) → 502 JSON bridge_unreachable", async (t) => {
  const kv = mockKV({ "machine:myroom": slot("https://myroom.trycloudflare.com") });
  const { restore } = mockFetch(() => {
    throw new Error("econnrefused");
  });
  t.after(restore);

  const res = await worker.fetch(
    apiRequest("/api/devices", { method: "GET", headers: { "x-owm-tenant": "myroom" } }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "bridge_unreachable");
});

test("/api/tenant/create: KV list lỗi → 503 JSON kv_error, không ném ra ngoài", async (t) => {
  const failingKV = {
    get: async () => null,
    put: async () => {},
    list: async () => {
      throw new Error("kv down");
    },
  };
  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "newroom", secret: "strongpass1" }) }),
    { OWM_STATE: failingKV }
  );

  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "kv_error");
});

test("/__register: KV ghi lỗi → 503 JSON kv_write_failed, không ném ra ngoài", async (t) => {
  const failingKV = {
    get: async () => null,
    put: async () => {
      throw new Error("kv down");
    },
    list: async () => ({ keys: [] }),
  };
  const res = await worker.fetch(
    apiRequest("/__register", {
      body: JSON.stringify({ url: "https://fresh.trycloudflare.com" }),
      headers: { "x-owm-secret": "main-secret" },
    }),
    { OWM_STATE: failingKV, BRIDGE_SECRET: "main-secret" }
  );

  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "kv_write_failed");
});

test("lỗi bất ngờ trong handle() → JSON worker_error thay vì trang 1101 HTML của Cloudflare", async (t) => {
  // URL hỏng làm new URL() ném ngay đầu handle() — đủ để chạm nhánh catch wrapper.
  const res = await worker.fetch(
    { url: "://bad-url", method: "GET", headers: new Headers() },
    { OWM_STATE: mockKV() }
  );

  assert.equal(res.status, 500);
  const payload = await res.json();
  assert.equal(payload.code, "worker_error");
  assert.equal(typeof payload.message, "string");
});

// ---------- FIX-3: rate limit /api/pair theo IP thật (cf-connecting-ip) ----------

test("FIX-3: POST /api/pair có tenant → 10 lượt/phút/IP, lượt 11 trả 429 rate_limited, IP khác vẫn vào", async (t) => {
  // Khoá thời gian cho cả test: bucket của rateLimited là
  // Math.floor(Date.now()/60_000), chạy qua ranh giới phút sẽ tự reset giữa
  // chừng và làm lượt 11 trả 200 — đỏ giả. Date.now là global, khôi phục sau.
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const pairFrom = (ip) =>
    worker.fetch(
      apiRequest("/api/pair", {
        body: '{"code":"owd_x"}',
        headers: { "x-owm-tenant": "alpha", "cf-connecting-ip": ip },
      }),
      { OWM_STATE: kv }
    );

  for (let i = 1; i <= 10; i += 1) {
    const res = await pairFrom("203.0.113.7");
    assert.equal(res.status, 200, `lượt ${i}/10 phải còn được relay, không phải 429`);
  }
  // Lượt 11 cùng IP, cùng phút → chặn, KHÔNG relay đi đâu
  const blocked = await pairFrom("203.0.113.7");
  assert.equal(blocked.status, 429);
  const payload = await blocked.json();
  assert.equal(payload.code, "rate_limited");
  assert.ok(payload.message.length > 10);
  assert.equal(calls.length, 10);
  // Lượt bị chặn không tăng bộ đếm (rateLimited chỉ put khi còn dưới trần)
  assert.equal(cache.count("pair", "203.0.113.7", "alpha"), 10);

  // IP khác = bucket riêng, không dính của IP trên
  const other = await pairFrom("198.51.100.9");
  assert.equal(other.status, 200);
  assert.equal(cache.count("pair", "198.51.100.9", "alpha"), 1);
});

test("FIX-3: POST /api/pair không tenant → vẫn 400 tenant_required, không đốt lượt rate limit", async (t) => {
  // Cache có bộ đếm thật để chứng minh cổng rate limit đứng SAU khi tách tenant:
  // request không tenant phải rơi xuống nhánh tenant_required mà không ghi
  // vào bucket "pair" — nếu ai đó gãn nhánh này lên trên thì lượt này sẽ
  // ghi bộ đếm (và thành 429) thay vì 400.
  const cache = useCountingCache(t);
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const res = await worker.fetch(
    apiRequest("/api/pair", {
      body: '{"code":"owd_x"}',
      headers: { "cf-connecting-ip": "203.0.113.20" },
    }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "tenant_required");
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
  assert.equal(cache.count("pair", "203.0.113.20"), 0);
});

// ---------- FIX-4: cờ môi trường ALLOW_ROOM_CREATE khóa cửa tạo phòng ----------

test('FIX-4: ALLOW_ROOM_CREATE = "0" → 403 room_create_disabled, không đụng KV', async (t) => {
  const kv = mockKV({
    "tenant:cua-toi": JSON.stringify({ secretHash: sha256("matkhau1"), name: "Của tôi" }),
  });
  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "newroom", secret: "strongpass1" }) }),
    { OWM_STATE: kv, ALLOW_ROOM_CREATE: "0" }
  );

  assert.equal(res.status, 403);
  const payload = await res.json();
  assert.equal(payload.code, "room_create_disabled");
  assert.ok(payload.message.length > 10);
  // Chặn ngay ở cổng: không đọc/ghi KV, phòng cũ còn nguyên
  assert.equal(kv.reads.length, 0);
  assert.deepEqual((await kv.list({ prefix: "tenant:" })).keys, [{ name: "tenant:cua-toi" }]);
});

/**
 * KV giả mô phỏng đúng race cướp tên phòng của FIX-4: lần đọc kiểm tra
 * (trước put) thấy phòng chưa tồn tại, nhưng tới lúc đọc lại sau put thì bản
 * ghi trên KV đã là của người chen vào với mật khẩu KHÁC — đúng thứ mà KV
 * không có CAS cho phép xảy ra (index.js:309-321). Bản ghi kẻ chen vào dùng
 * shape MỚI {secretHash}, y hệt phòng do /api/tenant/create tạo ra.
 * `readBack` = giá trị put trả về cho lần đọc lại: "null" mô phỏng KV
 * nhất quán theo colo chưa thấy bản vừa ghi.
 */
function racingKV(winnerSecret, readBack = "winner") {
  let written = false;
  return {
    async get(_key, type) {
      const raw = !written
        ? null
        : readBack === "null"
          ? null
          : JSON.stringify({ secretHash: sha256(winnerSecret), name: "Phòng của người khác" });
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put() {
      written = true;
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
  };
}

test("FIX-4: race cướp tên phòng → đọc lại thấy secret lệch thì 409 taken, không trả created", async (t) => {
  const kv = racingKV("matkhau-cu-nguoi-khac");
  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "newroom", secret: "strongpass1" }) }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 409);
  const payload = await res.json();
  assert.equal(payload.code, "taken");
  assert.ok(payload.message.length > 10);
  // Phòng KHÔNG còn của mình nên tuyệt đối không báo created/existed —
  // báo vậy GUI sẽ tưởng đã xong rồi đi đăng ký và nhận 401 về sau.
  assert.equal(payload.ok, undefined);
  assert.equal(payload.created, undefined);
});

test("FIX-4: read-after-write đọc hụt (null) → vẫn 200 created, không kêu taken oan", async (t) => {
  // KV nhất quán theo colo có thể chưa thấy bản vừa ghi — đọc hụt KHÔNG phải
  // bằng chứng ai cướp, nên chỉ kêu "taken" khi ĐỌC ĐƯỢC và secret lệch.
  const kv = racingKV("matkhau-cu-nguoi-khac", "null");
  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "newroom", secret: "strongpass1" }) }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.created, true);
  assert.equal(payload.user, "newroom");
});

test("FIX-4: không đặt ALLOW_ROOM_CREATE (hoặc \"1\") → vẫn tạo phòng như cũ, mặc định là MỞ", async (t) => {
  for (const flag of [undefined, "1"]) {
    const kv = mockKV();
    const res = await worker.fetch(
      apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "newroom", secret: "strongpass1" }) }),
      flag === undefined ? { OWM_STATE: kv } : { OWM_STATE: kv, ALLOW_ROOM_CREATE: flag }
    );

    assert.equal(res.status, 200, `ALLOW_ROOM_CREATE=${flag ?? "(không đặt)"} phải mở`);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.created, true);
    assert.equal(payload.user, "newroom");
    // Ghi thật xuống KV, đăng nhập lại được — và chỉ còn HASH, không còn mật
    // khẩu gốc nằm trên KV.
    const saved = await kv.get("tenant:newroom", "json");
    assert.equal(saved.secretHash, sha256("strongpass1"));
    assert.equal(saved.secret, undefined);
    assert.equal(saved.name, "newroom");
  }
});

// ---------- FIX-2: security headers của cửa worker ----------

test("FIX-2: static qua worker mang CSP + nosniff + no-referrer, header ASSETS gốc vẫn còn", async () => {
  // Cửa Cloudflare là 1 trong 3 cửa vào web (worker / bridge tunnel / Pages),
  // đặc tả FIX-2 yêu cầu 3 cửa mang CÙNG bộ giáp. Test này gọi thật
  // withSecurityHeaders() qua worker.fetch — không regex trên source — nên đổi
  // tên hằng hay bỏ lệnh headers.set(...) đều làm đỏ ở đây trước khi deploy.
  const seen = [];
  const env = {
    OWM_STATE: mockKV(),
    ASSETS: {
      async fetch(request) {
        seen.push(String(request.url));
        return new Response("<html>app shell</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "x-custom": "giu-lai" },
        });
      },
    },
  };

  const res = await worker.fetch(new Request("https://worker.test/rooms/abc/messages"), env);

  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["https://worker.test/rooms/abc/messages"], "phải gọi ASSETS với request gốc");
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  // Giáp gắn thêm, không xoá header mà binding ASSETS đã trả về.
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-custom"), "giu-lai");
});

// ---------- SECRET-1: KV chỉ giữ HASH mật khẩu, không còn plaintext ----------

/** Đăng nhập web (POST /api/pair/tenant) — trả cả response lẫn số lần relay. */
function signIn(kv, calls, user, secret, headers = {}) {
  return worker.fetch(
    apiRequest("/api/pair/tenant", {
      body: JSON.stringify({ user, secret }),
      headers,
    }),
    { OWM_STATE: kv }
  ).then((res) => res);
}

test("SECRET-1: phòng tạo mới → KV chỉ còn secretHash, KHÔNG có mật khẩu gốc ở bất kỳ chuỗi nào ghi xuống", async (t) => {
  const kv = mockKV();
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "phongmoi", secret: "matkhau-toi" }) }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 200);
  assert.equal((await res.json()).created, true);

  // Bản ghi đúng shape mới: hash khớp sha256, không còn field plaintext
  const saved = await kv.get("tenant:phongmoi", "json");
  assert.deepEqual(Object.keys(saved).sort(), ["createdAt", "name", "secretHash"]);
  assert.equal(saved.secretHash, sha256("matkhau-toi"));
  assert.match(saved.secretHash, /^[0-9a-f]{64}$/, "hash phải là hex chữ thường dài 64");

  // QUAN TRỌNG: quét MỌI giá trị từng đưa vào KV — không chuỗi nào chứa
  // mật khẩu gốc, kể cả khi nó có thể xuất hiện ở field khác (name, ghi chú).
  assert.ok(kv.writes.length > 0, "phải có ít nhất một lần ghi KV để test này có ý nghĩa");
  for (const w of kv.writes) {
    assert.ok(!w.value.includes("matkhau-toi"), `ghi lộ mật khẩu gốc vào KV ở ${w.key}: ${w.value}`);
  }
});

test("SECRET-1: đăng nhập phòng HASH → đúng mật khẩu 200, sai mật khẩu 401, và không lộ plaintext khi nâng cấp", async (t) => {
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "tenant:alpha": JSON.stringify({
      secretHash: sha256("dung-mat-khau"),
      name: "Alpha",
      createdAt: 1700000000000,
    }),
  });
  const { calls, restore } = mockFetch((url) =>
    url.startsWith("https://alpha.trycloudflare.com/") ? jsonRes(200, { ok: true }) : jsonRes(500, { url })
  );
  t.after(restore);

  const ok = await signIn(kv, calls, "alpha", "dung-mat-khau");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(calls.length, 1);

  const wrong = await signIn(kv, calls, "alpha", "sai-roi");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, "invalid_credentials");
  // Lượt sai không đụng tới tunnel của phòng
  assert.equal(calls.length, 1);

  // Bản ghi đã là shape mới thì KHÔNG ghi lại (tránh tốn KV write vô ích)
  assert.equal(kv.writes.length, 0);
});

test("SECRET-1: phòng CŨ (record {secret} plaintext của tenant.mjs) vẫn đăng nhập được và được nâng lên secretHash", async (t) => {
  const kv = mockKV({
    "machine:cu": slot("https://cu.trycloudflare.com"),
    // Đúng shape worker/scripts/tenant.mjs bản cũ ghi: {secret, name, createdAt}
    "tenant:cu": JSON.stringify({ secret: "matkhau-cu", name: "Cũ", createdAt: 1699999999999 }),
  });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const res = await signIn(kv, calls, "cu", "matkhau-cu");
  assert.equal(res.status, 200, "phải tương thích: phòng cũ vẫn vào được");
  assert.deepEqual(await res.json(), { ok: true });

  // Đã tự nâng cấp: mật khẩu gốc biến khỏi KV sau lần đăng nhập thành công
  const saved = await kv.get("tenant:cu", "json");
  assert.equal(saved.secretHash, sha256("matkhau-cu"));
  assert.equal(saved.secret, undefined, "không được giữ lại field plaintext");
  assert.equal(saved.name, "Cũ", "giữ nguyên tên phòng");
  assert.equal(saved.createdAt, 1699999999999, "giữ nguyên createdAt");
  for (const w of kv.writes) {
    assert.ok(!w.value.includes("matkhau-cu"), `nâng cấp lộ mật khẩu gốc ở ${w.key}: ${w.value}`);
  }

  // Và vẫn đăng nhập được sau khi đã nâng (lần 2 KHÔNG ghi thêm nữa)
  const again = await signIn(kv, calls, "cu", "matkhau-cu");
  assert.equal(again.status, 200);
  assert.equal(kv.writes.length, 1, "bản ghi đã hash rồi thì đừng ghi lại mỗi lượt");
});

test("SECRET-1: phòng CŨ sai mật khẩu → 401 và KHÔNG nâng cấp (không đoán mò ghi đè bản ghi)", async (t) => {
  const kv = mockKV({
    "machine:cu": slot("https://cu.trycloudflare.com"),
    "tenant:cu": JSON.stringify({ secret: "matkhau-cu", name: "Cũ", createdAt: 1699999999999 }),
  });
  const { restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const res = await signIn(kv, null, "cu", "doan-sai");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "invalid_credentials");
  assert.equal(kv.writes.length, 0, "đoán sai thì tuyệt đối không ghi gì lên KV");
});

test("SECRET-1: /__register của bridge chấp nhận CẢ hash lẫn bản ghi cũ, machine:main vẫn dùng BRIDGE_SECRET env", async (t) => {
  const kv = mockKV({
    "tenant:moi": JSON.stringify({ secretHash: sha256("khoa-bridge"), name: "Mới" }),
    "tenant:cu": JSON.stringify({ secret: "khoa-cu", name: "Cũ" }),
  });
  const { restore } = mockFetch(() => jsonRes(200, { unexpected: true }));
  t.after(restore);

  const reg = (user, secret) =>
    worker.fetch(
      apiRequest("/__register", {
        body: JSON.stringify({ url: "https://x.trycloudflare.com", tenant: user }),
        headers: { "x-owm-secret": secret },
      }),
      { OWM_STATE: kv }
    );

  assert.equal((await reg("moi", "khoa-bridge")).status, 200, "bản ghi hash phải qua");
  assert.equal((await reg("moi", "sai")).status, 401);
  assert.equal((await reg("cu", "khoa-cu")).status, 200, "bản ghi cũ phải qua");
  assert.equal((await reg("cu", "sai")).status, 401);

  // machine:main: KHÔNG có tenant, secret lấy từ env BRIDGE_SECRET (chưa, và
  // không được băm — env vẫn là nguồn sự thật plaintext của chủ worker)
  const main = await worker.fetch(
    apiRequest("/__register", {
      body: JSON.stringify({ url: "https://main.trycloudflare.com" }),
      headers: { "x-owm-secret": "main-secret" },
    }),
    { OWM_STATE: kv, BRIDGE_SECRET: "main-secret" }
  );
  assert.equal(main.status, 200);
  assert.equal((await kv.get("machine:main", "json")).url, "https://main.trycloudflare.com");

  const badMain = await worker.fetch(
    apiRequest("/__register", {
      body: JSON.stringify({ url: "https://x.trycloudflare.com" }),
      headers: { "x-owm-secret": "sai-secret" },
    }),
    { OWM_STATE: kv, BRIDGE_SECRET: "main-secret" }
  );
  assert.equal(badMain.status, 401);
});

test("SECRET-1: /api/tenant/create với phòng CŨ + đúng mật khẩu → existed và cũng được nâng lên secretHash", async (t) => {
  const kv = mockKV({
    "tenant:cu": JSON.stringify({ secret: "matkhau-cu", name: "Tên Cũ", createdAt: 1699999999999 }),
  });

  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "cu", secret: "matkhau-cu" }) }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.existed, true);
  assert.equal(payload.name, "Tên Cũ");

  const saved = await kv.get("tenant:cu", "json");
  assert.equal(saved.secretHash, sha256("matkhau-cu"));
  assert.equal(saved.secret, undefined);
});

test("SECRET-1: /api/tenant/create với phòng CŨ + sai mật khẩu → 401 taken, KHÔNG đụng bản ghi", async (t) => {
  const kv = mockKV({
    "tenant:cu": JSON.stringify({ secret: "matkhau-cu", name: "Tên Cũ", createdAt: 1699999999999 }),
  });

  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "cu", secret: "mat-khau-sai" }) }),
    { OWM_STATE: kv }
  );

  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "taken");
  assert.equal(kv.writes.length, 0);
});

test("SECRET-1: nâng cấp hỏng (KV ghi lỗi) → đăng nhập VẪN thành công, không mất phiên", async (t) => {
  const base = mockKV({
    "machine:cu": slot("https://cu.trycloudflare.com"),
    "tenant:cu": JSON.stringify({ secret: "matkhau-cu", name: "Cũ", createdAt: 1699999999999 }),
  });
  // get/list y như KV thật, chỉ put ném lỗi — mô phỏng quota/hạ tầng.
  const kv = {
    reads: base.reads,
    writes: base.writes,
    get: base.get,
    list: base.list,
    async put(key, value) {
      base.writes.push({ key, value: String(value) });
      throw new Error("kv write quota exceeded");
    },
  };
  const { restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const res = await signIn(kv, null, "cu", "matkhau-cu");
  assert.equal(res.status, 200, "lỗi ghi không được biến thành 401");
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------- LIMIT-1: rate-limit tách bucket theo PHÒNG, không theo IP đơn thuần ----------

test("LIMIT-1: 2 phòng khác nhau CÙNG 1 IP → mỗi phòng 10 lượt riêng, không dính bucket nhau", async (t) => {
  // Kịch bản thật: cả nhà ngồi sau một NAT/vpn chung, đoán mật khẩu phòng "beta"
  // không được dùng hết lượt ghép máy của phòng "alpha".
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "machine:beta": slot("https://beta.trycloudflare.com"),
  });
  const { calls, restore } = mockFetch((url) =>
    url.startsWith("https://alpha.trycloudflare.com/")
      ? jsonRes(200, { ok: true, room: "alpha" })
      : jsonRes(200, { ok: true, room: "beta" })
  );
  t.after(restore);

  const SHARED_IP = "203.0.113.50";
  const pair = (room) =>
    worker.fetch(
      apiRequest("/api/pair", {
        body: '{"code":"owd_x"}',
        headers: { "x-owm-tenant": room, "cf-connecting-ip": SHARED_IP },
      }),
      { OWM_STATE: kv }
    );

  // 10 lượt của alpha đứng hết trần của CHÍNH nó
  for (let i = 1; i <= 10; i += 1) {
    const res = await pair("alpha");
    assert.equal(res.status, 200, `alpha lượt ${i}/10 phải còn được relay`);
  }
  // ...nhưng beta cùng IP vẫn trọn 10 lượt, không dính lượt của alpha
  for (let i = 1; i <= 10; i += 1) {
    const res = await pair("beta");
    assert.equal(res.status, 200, `beta lượt ${i}/10 phải còn được relay, không dính bucket của alpha`);
  }
  assert.equal(cache.count("pair", SHARED_IP, "alpha"), 10);
  assert.equal(cache.count("pair", SHARED_IP, "beta"), 10);
  assert.equal(calls.length, 20);

  // Lượt 11 thì CHỈ phòng đã trọn bị chặn
  const blocked = await pair("alpha");
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "rate_limited");
  assert.equal(calls.length, 20, "lượt bị chặn không relay đi đâu");

  const blockedBeta = await pair("beta");
  assert.equal(blockedBeta.status, 429);
  assert.equal(calls.length, 20);
});

test("LIMIT-1: cùng phòng vượt 10 lượt → 429, kể cả khi đổi IP", async (t) => {
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const pair = (ip) =>
    worker.fetch(
      apiRequest("/api/pair", {
        body: '{"code":"owd_x"}',
        headers: { "x-owm-tenant": "alpha", "cf-connecting-ip": ip },
      }),
      { OWM_STATE: kv }
    );

  for (let i = 1; i <= 10; i += 1) assert.equal((await pair("203.0.113.7")).status, 200);
  assert.equal((await pair("203.0.113.7")).status, 429);
  // IP khác = bucket khác, vẫn vào được (giữ đúng hành vi cũ theo IP)
  assert.equal((await pair("198.51.100.9")).status, 200);
  assert.equal(cache.count("pair", "203.0.113.7", "alpha"), 10);
  assert.equal(cache.count("pair", "198.51.100.9", "alpha"), 1);
  assert.equal(calls.length, 11);
});

test("LIMIT-1: /api/pair/tenant đoán sai ở phòng này không dùng lượt của phòng khác (cùng IP)", async (t) => {
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "tenant:alpha": JSON.stringify({ secretHash: sha256("khoa-alpha"), name: "Alpha" }),
  });
  const { restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const SHARED_IP = "198.51.100.77";
  const attempt = (user, secret) =>
    worker.fetch(
      apiRequest("/api/pair/tenant", {
        body: JSON.stringify({ user, secret }),
        headers: { "cf-connecting-ip": SHARED_IP },
      }),
      { OWM_STATE: kv }
    );
  const guess = (user) => attempt(user, "doan-mat-khau");

  for (let i = 1; i <= 10; i += 1) {
    const res = await guess("alpha");
    assert.equal(res.status, 401, `lượt ${i} phải 401 (sai mật khẩu), không phải 429 sớm`);
  }
  const blocked = await guess("alpha");
  assert.equal(blocked.status, 429, "phòng alpha đã trọn 10 lượt thì chặn");
  assert.equal((await blocked.json()).code, "rate_limited");

  // Bucket tính theo (loại cửa, PHÒNG, IP) chứ không theo thành công/thất bại,
  // nên chủ phòng đúng mật khẩu trên IP đó cũng bị chặn tới hết phút. Đây là
  // đánh đổi đã chấp nhận: 1 phút chờ còn hơn cho kẻ đoán 10 lượt/phút, và IP
  // dùng chung là ca hiếm — còn việc chặn tràn sang phòng khác thì đã hết.
  assert.equal((await attempt("alpha", "khoa-alpha")).status, 429);

  // Phòng khác cùng IP vẫn trọn bộ lượt riêng — đây mới là điều phải bảo vệ
  assert.equal((await guess("beta")).status, 401);
  assert.equal(cache.count("pair-tenant", SHARED_IP, "alpha"), 10);
  assert.equal(cache.count("pair-tenant", SHARED_IP, "beta"), 1);
});

test("LIMIT-1: tên phòng rác (không qua TENANT_RE) đổi tên bucket nhưng không lộ ra, và create-room vẫn khoá theo IP", async (t) => {
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV();
  const { restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const IP = "203.0.113.99";
  const junk = () =>
    worker.fetch(
      apiRequest("/api/pair/tenant", {
        body: JSON.stringify({ user: "Không Hợp Lệ!!", secret: "x" }),
        headers: { "cf-connecting-ip": IP },
      }),
      { OWM_STATE: kv }
    );
  for (let i = 1; i <= 10; i += 1) assert.equal((await junk()).status, 401);
  assert.equal((await junk()).status, 429);
  // Lượt rác nằm ở bucket không có tên phòng, KHÔNG chồng lên bucket phòng thật
  assert.equal(cache.count("pair-tenant", IP), 10);
  assert.equal(cache.count("pair-tenant", IP, "alpha"), 0);

  // create-room: không truyền scope (lúc tạo chưa có phòng) → key KHÔNG có
  // tầng phòng, khoá theo IP y như trước.
  for (let i = 1; i <= 5; i += 1) {
    const res = await worker.fetch(
      apiRequest("/api/tenant/create", {
        body: JSON.stringify({ user: `room-${i}`, secret: "strongpass1" }),
        headers: { "cf-connecting-ip": "192.0.2.10" },
      }),
      { OWM_STATE: mockKV() }
    );
    assert.equal(res.status, 200, `lượt tạo phòng ${i}/5 phải được`);
  }
  const over = await worker.fetch(
    apiRequest("/api/tenant/create", {
      body: JSON.stringify({ user: "room-6", secret: "strongpass1" }),
      headers: { "cf-connecting-ip": "192.0.2.10" },
    }),
    { OWM_STATE: mockKV() }
  );
  assert.equal(over.status, 429);
  assert.equal((await over.json()).code, "rate_limited");
  assert.equal(cache.count("create-room", "192.0.2.10"), 5);
  assert.equal(cache.count("create-room", "192.0.2.10", "room-1"), 0);
  // Không key nào của create-room chứa tầng tên phòng
  for (const url of cache.urls()) {
    if (url.includes("/create-room/")) assert.match(url, /\/create-room\/192\.0\.2\.10\/\d+$/);
  }
});

// ---------- CREATE-1: ALLOW_ROOM_CREATE đọc mọi kiểu viết của "tắt" ----------

/** Gọi /api/tenant/create với một giá trị cờ cho trước; `undefined` = không đặt. */
async function createWithFlag(flag, { seed = {} } = {}) {
  const kv = mockKV(seed);
  const env = flag === undefined ? { OWM_STATE: kv } : { OWM_STATE: kv, ALLOW_ROOM_CREATE: flag };
  const res = await worker.fetch(
    apiRequest("/api/tenant/create", { body: JSON.stringify({ user: "phongmoi", secret: "strongpass1" }) }),
    env
  );
  return { kv, res, payload: await res.json() };
}

// Cờ "tắt": 403 room_create_disabled, KHÔNG đụng KV.
const CREATE_OFF_CASES = [
  ["chuỗi \"0\"", "0"],
  ["chuỗi \"false\"", "false"],
  ["chuỗi \"no\"", "no"],
  ["chuỗi \"off\"", "off"],
  ["SỐ 0 (không phải chuỗi)", 0],
  ["FALSE viết HOA", "FALSE"],
  ["\" Off \" có khoảng trắng + HOA", " Off "],
];

for (const [label, flag] of CREATE_OFF_CASES) {
  test(`CREATE-1: ALLOW_ROOM_CREATE = ${label} → 403 room_create_disabled, không đụng KV`, async () => {
    const seed = { "tenant:cu": JSON.stringify({ secretHash: sha256("matkhau1"), name: "Cũ" }) };
    const { kv, res, payload } = await createWithFlag(flag, { seed });

    assert.equal(res.status, 403, `${label} phải khoá cửa tạo phòng`);
    assert.equal(payload.code, "room_create_disabled");
    assert.ok(payload.message.length > 10);
    assert.equal(kv.reads.length, 0, `${label}: phải chặn ngay ở cổng, không đọc KV`);
    assert.equal(kv.writes.length, 0);
    // Phòng cũ còn nguyên, không bị xoá/ghi đè
    assert.deepEqual((await kv.list({ prefix: "tenant:" })).keys, [{ name: "tenant:cu" }]);
  });
}

// Cờ "mở": 200 created — không đặt, hoặc viết theo kiểu bật.
const CREATE_ON_CASES = [
  ["không đặt", undefined],
  ["chuỗi \"1\"", "1"],
  ["chuỗi \"true\"", "true"],
  ["chuỗi \"yes\"", "yes"],
  ["chuỗi \"on\"", "on"],
  ["chuỗi rỗng \"\"", ""],
  ["\" TRUE \" khoảng trắng + HOA", " TRUE "],
  ["SỐ 1", 1],
];

for (const [label, flag] of CREATE_ON_CASES) {
  test(`CREATE-1: ALLOW_ROOM_CREATE = ${label} → vẫn tạo phòng, mặc định là MỞ`, async () => {
    const { kv, res, payload } = await createWithFlag(flag);

    assert.equal(res.status, 200, `${label} phải mở cửa tạo phòng`);
    assert.equal(payload.ok, true);
    assert.equal(payload.created, true);
    assert.equal(payload.user, "phongmoi");

    const saved = await kv.get("tenant:phongmoi", "json");
    assert.equal(saved.secretHash, sha256("strongpass1"));
  });
}

test("CREATE-1: cờ tắt KHÔNG chặn việc đăng nhập phòng đã có", async (t) => {
  // Cờ chỉ chặn TẠO phòng mới — phòng cũ vẫn vào và dùng lại được y như trước.
  const kv = mockKV({
    "machine:cu": slot("https://cu.trycloudflare.com"),
    "tenant:cu": JSON.stringify({ secretHash: sha256("matkhau-cu"), name: "Cũ" }),
  });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const signIn = await worker.fetch(
    apiRequest("/api/pair/tenant", {
      body: JSON.stringify({ user: "cu", secret: "matkhau-cu" }),
      headers: { "cf-connecting-ip": "203.0.113.5" },
    }),
    { OWM_STATE: kv, ALLOW_ROOM_CREATE: "off" }
  );
  assert.equal(signIn.status, 200);
  assert.equal(calls.length, 1);

  const create = await worker.fetch(
    apiRequest("/api/tenant/create", {
      body: JSON.stringify({ user: "phongmoi", secret: "strongpass1" }),
      headers: { "cf-connecting-ip": "203.0.113.5" },
    }),
    { OWM_STATE: kv, ALLOW_ROOM_CREATE: "off" }
  );
  assert.equal(create.status, 403, "tạo phòng MỚI thì vẫn phải bị chặn");
});

// ---------- LIMIT-2: tầng trần THÔ theo IP, cộng dồn với trần theo phòng ----------

test("LIMIT-2: 1 IP đổi tên phòng hợp lệ liên tục → vẫn bị chặn ở trần thô, không đốt KV vô hạn", async (t) => {
  // Tên phòng hợp lệ thì ai cũng đoán ra ("zz1".."zz9999"), nên chỉ tách bucket
  // theo phòng là lỗ hổng: mỗi tên một bucket SẠCH. Vì /api/pair/tenant không
  // cần token và mỗi lượt đọc 1 KV record, IP này sẽ đốt hạn mức KV chung của
  // cả tòa nhà (free 100k/ngày) tới cạn, /__register đọc hụt theo → mọi phòng
  // mất heartbeat và thành offline. Test này khóa cái trần thô đó.
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  const cache = useCountingCache(t);
  const kv = mockKV({});
  const { restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const ATTACKER_IP = "203.0.113.66";
  const guess = (user, ip = ATTACKER_IP) =>
    worker.fetch(
      apiRequest("/api/pair/tenant", {
        body: JSON.stringify({ user, secret: "doan-mat-khau" }),
        headers: { "cf-connecting-ip": ip },
      }),
      { OWM_STATE: kv }
    );

  // 3 phòng × 10 lượt = 30 lượt, đúng bằng trần thô. Mỗi phòng vẫn trọn lượt
  // riêng (đó là thứ cần giữ từ LIMIT-1).
  for (const room of ["zz1", "zz2", "zz3"]) {
    for (let i = 1; i <= 10; i += 1) {
      assert.equal((await guess(room)).status, 401, `${room} lượt ${i}/10 phải còn chạy tới bước so mật khẩu`);
    }
  }
  assert.equal(cache.count("pair-tenant", ATTACKER_IP, "zz1"), 10);
  assert.equal(cache.count("pair-tenant", ATTACKER_IP, "zz2"), 10);
  assert.equal(cache.count("pair-tenant", ATTACKER_IP, "zz3"), 10);
  assert.equal(cache.count("pair-tenant-ip", ATTACKER_IP), 30);

  // Phòng thứ TƯ chưa từng đoán: bucket phòng vẫn trống, nhưng trần thô đã cạn
  // → 429. Không có tầng thô thì lượt này lọt và đốt thêm KV read.
  const blocked = await guess("zz4");
  assert.equal(blocked.status, 429, "đổi sang phòng mới không phải cách né trần thô theo IP");
  assert.equal((await blocked.json()).code, "rate_limited");
  assert.equal(cache.count("pair-tenant", ATTACKER_IP, "zz4"), 0, "lượt bị chặn không tạo bucket phòng mới");

  // IP khác không dính — trần thô bám IP, không bám tên phòng đã đoán.
  assert.equal((await guess("zz4", "203.0.113.77")).status, 401, "IP khác phải còn lượt của mình");
});

test("LIMIT-2: nhà thật sau NAT đăng nhập 3 phòng với ĐÚNG mật khẩu → 30 lượt vẫn đủ, không ăn trần thô", async (t) => {
  const frozen = Date.now();
  const realNow = Date.now;
  Date.now = () => frozen;
  t.after(() => (Date.now = realNow));

  useCountingCache(t);
  const kv = mockKV({
    "machine:nha1": slot("https://nha1.trycloudflare.com"),
    "machine:nha2": slot("https://nha2.trycloudflare.com"),
    "machine:nha3": slot("https://nha3.trycloudflare.com"),
    "tenant:nha1": JSON.stringify({ secretHash: sha256("khoa-nha-1"), name: "Nhà 1" }),
    "tenant:nha2": JSON.stringify({ secretHash: sha256("khoa-nha-2"), name: "Nhà 2" }),
    "tenant:nha3": JSON.stringify({ secretHash: sha256("khoa-nha-3"), name: "Nhà 3" }),
  });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  // Một IP chung cho cả nhà (NAT ở nhà hoặc vpn công ty) — tình huống mà việc
  // tách bucket theo phòng sinh ra để bảo vệ. Đăng nhập đúng vẫn phải vào được.
  const NAT_IP = "198.51.100.31";
  const signIn = (user, secret) =>
    worker.fetch(
      apiRequest("/api/pair/tenant", {
        body: JSON.stringify({ user, secret }),
        headers: { "cf-connecting-ip": NAT_IP },
      }),
      { OWM_STATE: kv }
    );

  // 3 phòng × 10 lượt = 30 lượt: đúng bằng trần thô, và phải VÀO ĐƯỢC HẾT.
  // Đây là con số chốt được ở rateLimited(): nhà thật dùng chung NAT không bị
  // đá vì kẻ xấu đổi tên phòng.
  let ok = 0;
  for (const [user, secret] of [["nha1", "khoa-nha-1"], ["nha2", "khoa-nha-2"], ["nha3", "khoa-nha-3"]]) {
    for (let i = 1; i <= 10; i += 1) {
      const res = await signIn(user, secret);
      assert.equal(res.status, 200, `${user} lượt ${i}/10 phải vào được, lượt ${ok + 1} tổng chưa vượt 30`);
      ok += 1;
    }
  }
  assert.equal(calls.length, 30, "cả 30 lượt đều relay đi");

  // Lượt 31 mới ăn trần thô, và nó không tạo thêm lượt relay nào.
  const blocked = await signIn("nha1", "khoa-nha-1");
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, "rate_limited");
  assert.equal(calls.length, 30, "lượt bị chặn không relay đi đâu");
});
