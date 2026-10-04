// Unit tests cho lib/blob-cache.js — cache object URL dùng cho <img>/<iframe>.
// `create`/`revoke` được tiêm nên test chạy không cần DOM, không cần bridge.
import test from "node:test";
import assert from "node:assert/strict";

import { blobCacheKey, createBlobCache, parseBlobCacheKey } from "../src/lib/blob-cache.js";

/** Cache với make() đếm số lần tải và trả URL giả — mỗi key một URL riêng. */
function harness({ bytes, entries, make } = {}) {
  const revoked = [];
  let loads = 0;
  const cache = createBlobCache({
    bytes,
    entries,
    revoke: (url) => revoked.push(url),
    create:
      make ??
      (async (key) => {
        loads += 1;
        return { url: `blob:${key}#${loads}`, bytes: 10 };
      }),
  });
  return { cache, revoked, loads: () => loads };
}

test("khoá cache phân biệt workspace — cùng tên file ở máy khác là mục khác", () => {
  assert.equal(blobCacheKey("ws_1", "a.png"), "ws_1\u0000a.png");
  assert.notEqual(blobCacheKey("ws_1", "a.png"), blobCacheKey("ws_2", "a.png"));
  const back = parseBlobCacheKey(blobCacheKey("ws_1", "src/a.png"));
  assert.deepEqual(back, { wsId: "ws_1", path: "src/a.png" });
});

test("parseBlobCacheKey của key không có phân tách không ném", () => {
  assert.deepEqual(parseBlobCacheKey(""), { wsId: "", path: "" });
  assert.deepEqual(parseBlobCacheKey("no-sep"), { wsId: "", path: "no-sep" });
});

test("lần đầu tải, lần sau trả URL đã cache mà không tải lại", async () => {
  const { cache, loads } = harness();
  const first = await cache.load("k1");
  const second = await cache.load("k1");
  assert.equal(first, second);
  assert.equal(loads(), 1);
  assert.equal(cache.peek("k1"), first);
  assert.equal(cache.has("k1"), true);
});

test("peek không tải và trả chuỗi rỗng cho key lạ", async () => {
  const { cache, loads } = harness();
  assert.equal(cache.peek("chua-tai"), "");
  assert.equal(loads(), 0);
});

test("hai lượt cùng key chạy song song chỉ tải MỘT lần", async () => {
  let calls = 0;
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  const revoked = [];
  const cache = createBlobCache({
    revoke: (u) => revoked.push(u),
    create: async (key) => {
      calls += 1;
      await gate;
      return `blob:${key}`;
    },
  });
  const a = cache.load("k1");
  const b = cache.load("k1");
  release();
  assert.deepEqual(await Promise.all([a, b]), ["blob:k1", "blob:k1"]);
  assert.equal(calls, 1);
  assert.equal(cache.size, 1);
});

test("lượt thất bại không để lại cache rác, và thử lại được", async () => {
  let attempt = 0;
  const cache = createBlobCache({
    create: async (key) => {
      attempt += 1;
      if (attempt === 1) throw new Error("HTTP 404");
      return `blob:${key}`;
    },
  });
  await assert.rejects(() => cache.load("k1"), /404/);
  assert.equal(cache.size, 0);
  assert.equal(await cache.load("k1"), "blob:k1");
  assert.equal(attempt, 2);
});

test("đuổi theo số mục, thu hồi URL cũ nhất", async () => {
  const { cache, revoked } = harness({ entries: 2 });
  await cache.load("a");
  await cache.load("b");
  await cache.load("c");
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false);
  assert.deepEqual(revoked, ["blob:a#1"]);
  assert.equal(cache.has("b"), true);
  assert.equal(cache.has("c"), true);
});

test("đọc cache cũng chạm LRU — file vừa xem không bị đuổi", async () => {
  const { cache, revoked } = harness({ entries: 2 });
  await cache.load("a");
  await cache.load("b");
  await cache.load("a"); // đọc lại "a" -> "a" thành mới nhất
  await cache.load("c");
  assert.equal(cache.has("a"), true, "a vừa xem phải còn");
  assert.equal(cache.has("b"), false, "b mới là nạn nhân");
  assert.deepEqual(revoked, ["blob:b#2"]);
});

test("đuổi theo tổng bytes — ảnh nặng đẩy ảnh nhẏ hơn ra", async () => {
  const revoked = [];
  const sizes = { a: 30, b: 30, c: 30 };
  let n = 0;
  const cache = createBlobCache({
    bytes: 70, // chỉ chứa được 2 file
    revoke: (u) => revoked.push(u),
    create: async (key) => ({ url: `blob:${key}#${(n += 1)}`, bytes: sizes[key] }),
  });
  await cache.load("a");
  await cache.load("b");
  await cache.load("c");
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false);
  assert.equal(cache.bytes, 60);
  assert.deepEqual(revoked, ["blob:a#1"]);
});

test("mục vừa thêm dù vượt trần vẫn được giữ (không mất ảnh đang xem)", async () => {
  const revoked = [];
  const cache = createBlobCache({
    bytes: 10,
    revoke: (u) => revoked.push(u),
    create: async (key) => ({ url: `blob:${key}`, bytes: 999 }),
  });
  const url = await cache.load("lon");
  assert.equal(cache.peek("lon"), url);
  assert.equal(cache.size, 1);
  assert.deepEqual(revoked, []);
});

test("make trả string thì bytes = 0, vẫn tính vào số mục", async () => {
  const { cache, revoked } = harness({ entries: 1, make: async (key) => `blob:${key}` });
  await cache.load("a");
  await cache.load("b");
  assert.equal(cache.bytes, 0);
  assert.deepEqual(revoked, ["blob:a"]);
});

test("drop bỏ đúng một key, key khác giữ nguyên", async () => {
  const { cache, revoked } = harness();
  await cache.load("a");
  await cache.load("b");
  assert.equal(cache.drop("a"), true);
  assert.equal(cache.drop("a"), false);
  assert.deepEqual(revoked, ["blob:a#1"]);
  assert.equal(cache.size, 1);
  assert.equal(cache.has("b"), true);
});

test("drop phải trừ bytes để trần đo đúng", async () => {
  const revoked = [];
  const cache = createBlobCache({
    bytes: 100,
    revoke: (u) => revoked.push(u),
    create: async (key) => ({ url: `blob:${key}`, bytes: 40 }),
  });
  await cache.load("a");
  await cache.load("b");
  assert.equal(cache.bytes, 80);
  cache.drop("a");
  assert.equal(cache.bytes, 40);
  assert.equal(cache.size, 1);
});

test("make trả URL rỗng thì ném, không cache rỗng", async () => {
  const cache = createBlobCache({ create: async () => "" });
  await assert.rejects(() => cache.load("k"), /rỗng/);
  assert.equal(cache.size, 0);
});

test("clear thu hồi mọi URL và reset cả bytes", async () => {
  const { cache, revoked } = harness();
  await cache.load("a");
  await cache.load("b");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(revoked.length, 2);
});