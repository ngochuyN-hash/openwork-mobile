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
