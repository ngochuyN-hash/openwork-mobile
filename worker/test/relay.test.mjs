// Test relay của worker/src/index.js — chạy thuần Node >= 22 (module syntax
// detection cho phép import thẳng file .js kiểu ESM), KHÔNG đụng mạng thật:
//   - global fetch bị thay bằng mock ghi lại mọi lần gọi (url/method/headers/body)
//   - env.OWM_STATE là KV giả trong bộ nhớ (get/put/list đủ cho worker)
// Chạy: node --test worker/test/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const worker = (await import("../src/index.js")).default;

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

test("bootstrap /api/pair: máy 1 trả 401, máy 2 nhận body y hệt và thành công", async (t) => {
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "machine:beta": slot("https://beta.trycloudflare.com"),
  });
  const payload = { code: "owd_test_key", device: "phone-1", nested: { ok: true } };
  const { calls, restore } = mockFetch((url) => {
    if (url.startsWith("https://alpha.trycloudflare.com/")) return jsonRes(401, { code: "bad_key" });
    if (url.startsWith("https://beta.trycloudflare.com/")) return jsonRes(200, { ok: true, pong: payload.code });
    return jsonRes(500, { unexpected: url });
  });
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/pair", { body: JSON.stringify(payload) }), {
    OWM_STATE: kv,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pong: payload.code });

  // Quét đủ 2 slot theo thứ tự KV list: alpha (401) trước, beta (200) sau
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://alpha.trycloudflare.com/api/pair");
  assert.equal(calls[1].url, "https://beta.trycloudflare.com/api/pair");

  // Body đọc MỘT lần từ request rồi truyền nguyên văn cho TẤT CẢ ứng viên —
  // máy 2 phải nhận chuỗi body giống hệt máy 1 (không phải stream đã tiêu)
  const expected = JSON.stringify(payload);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, expected);
    assert.deepEqual(JSON.parse(call.init.body), payload);
    assert.equal(call.headers.get("content-type"), "application/json");
    assert.equal(call.headers.get("host"), null); // host bị gỡ trước khi relay
    assert.equal(call.headers.get("accept-encoding"), "identity");
  }
});

test("bootstrap /api/pair: mọi máy cùng từ chối 401 → trả 401 của bridge", async (t) => {
  const kv = mockKV({
    "machine:alpha": slot("https://alpha.trycloudflare.com"),
    "machine:beta": slot("https://beta.trycloudflare.com"),
  });
  const { calls, restore } = mockFetch(() => jsonRes(401, { code: "bad_key", message: "Sai khóa" }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/pair", { body: '{"code":"owd_wrong"}' }), {
    OWM_STATE: kv,
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: "bad_key", message: "Sai khóa" });
  // Chỉ quét đúng các slot machine:*, mỗi slot đúng 1 lần
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.body, JSON.stringify({ code: "owd_wrong" }));
});

test("bootstrap /api/pair: không còn slot machine nào → fallback relay về machine:main", async (t) => {
  // KV list có thể chưa thấy slot mà get đã đọc được (eventual consistency).
  // Buộc danh sách rỗng nhưng main tồn tại để kiểm tra body ở nhánh fallback.
  const kv = mockKV({
    "machine:main": slot("https://main.trycloudflare.com"),
  });
  kv.list = async () => ({ keys: [], list_complete: true, cursor: "" });
  const { calls, restore } = mockFetch(() => jsonRes(200, { ok: true }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/pair", { body: '{"code":"owd_x"}' }), {
    OWM_STATE: kv,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://main.trycloudflare.com/api/pair");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"code":"owd_x"}');
  assert.deepEqual(kv.reads, ["machine:main"]);
});

test("bootstrap /api/pair: body JSON hỏng / không phải object → 400, không relay", async (t) => {
  const kv = mockKV();
  const { calls, restore } = mockFetch(() => jsonRes(200, { never: true }));
  t.after(restore);

  for (const bad of ["{không phải json", "[]", '"chuỗi"', "5"]) {
    const res = await worker.fetch(apiRequest("/api/pair", { body: bad }), { OWM_STATE: kv });
    assert.equal(res.status, 400, `body ${JSON.stringify(bad)} phải trả 400`);
    assert.equal((await res.json()).code, "invalid_body");
  }
  // Chặn ngay từ cổng: không gọi mạng, không đốt lượt đọc KV
  assert.equal(calls.length, 0);
  assert.equal(kv.reads.length, 0);
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

test("bootstrap GET /api/state: không tenant → quét slot, relay GET không body", async (t) => {
  const kv = mockKV({ "machine:alpha": slot("https://alpha.trycloudflare.com") });
  const { calls, restore } = mockFetch(() => jsonRes(200, { edge: { tenant: "alpha", online: true } }));
  t.after(restore);

  const res = await worker.fetch(apiRequest("/api/state", { method: "GET" }), { OWM_STATE: kv });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { edge: { tenant: "alpha", online: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://alpha.trycloudflare.com/api/state");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined); // GET không mang body
});
