// Test relay của worker/src/index.js — chạy thuần Node >= 22 (module syntax
// detection cho phép import thẳng file .js kiểu ESM), KHÔNG đụng mạng thật:
//   - global fetch bị thay bằng mock ghi lại mọi lần gọi (url/method/headers/body)
//   - env.OWM_STATE là KV giả trong bộ nhớ (get/put/list đủ cho worker)
//   - caches.default (Cache API của runtime Workers, dùng cho rate-limit) được
//     stub vì Node không có — không stub thì rateLimited ném TypeError.
// Chạy: node --test worker/test/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;

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
  return {
    reads,
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
 * `count(kind, ip)` cộng dồn mọi bucket phút của một cặp kind/IP.
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
    count(kind, ip) {
      const prefix = `https://owm-ratelimit/${kind}/${encodeURIComponent(ip)}/`;
      let sum = 0;
      for (const [url, value] of store) if (url.startsWith(prefix)) sum += Number(value);
      return sum;
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
  assert.equal(cache.count("pair", "203.0.113.7"), 10);

  // IP khác = bucket riêng, không dính của IP trên
  const other = await pairFrom("198.51.100.9");
  assert.equal(other.status, 200);
  assert.equal(cache.count("pair", "198.51.100.9"), 1);
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
  const kv = mockKV({ "tenant:cua-toi": JSON.stringify({ secret: "matkhau1", name: "Của tôi" }) });
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
 * ghi trên KV đã là của người chen vào với secret KHÁC — đúng thứ mà KV không
 * có CAS cho phép xảy ra (index.js:309-321).
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
          : JSON.stringify({ secret: winnerSecret, name: "Phòng của người khác" });
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
    // Ghi thật xuống KV, đăng nhập lại được
    const saved = await kv.get("tenant:newroom", "json");
    assert.equal(saved.secret, "strongpass1");
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
