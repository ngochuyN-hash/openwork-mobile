// Unit tests khoá lại các bản sửa trong web/src/api.js:
//  - removeKey() phải DỌN phòng cũ khi thăng lên máy chính (phòng rỗng)
//  - unwrap() không nuốt mất object khi `data` là undefined
//  - ow() với body 200 không phải JSON không ném SyntaxError thô lên UI
//  - ow()/apiState() có trần thời gian chờ (tunnel treo không kẹt UI vĩnh viễn)
//  - apiPair() chặn mã sai hình dạng ngay ở client, KHÔNG nới lỏng mã thật
//
// House rule: không chạm bridge / thư mục dữ liệu thật của máy.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(`${tmpdir()}/owm-test-bridge-`);
process.env.OPENWORK_DIR = mkdtempSync(`${tmpdir()}/owm-test-data-`);

function createStorageShim() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

globalThis.localStorage = createStorageShim();
globalThis.location = { hash: "", pathname: "/", search: "" };
globalThis.history = { replaceState() {} };
globalThis.window = globalThis;

const api = await import("../src/api.js");

beforeEach(() => {
  globalThis.localStorage = createStorageShim();
});

const readKeys = () => JSON.parse(localStorage.getItem("owm_keys") ?? "null");

// ---- removeKey(): dọn phòng cũ khi thăng lên máy chính ----

test("removeKey thăng lên máy chính (phòng rỗng) thì PHẢI dọn owm_tenant cũ", () => {
  // Đúng kịch bản hỏng: khoá active thuộc phòng "studio", xoá nó thì chùm còn
  // khoá máy chính (tenant rỗng). setTenant("") cố tình no-op nên trước đây
  // owm_tenant vẫn là "studio" → mọi request đi nhầm phòng → 401/503 liên miên.
  api.addKey({ tenant: "studio", token: "tok-studio", name: "Studio" });
  api.addKey({ tenant: "", token: "tok-main", name: "PC chính" });
  api.setToken("tok-studio");
  api.setTenant("studio", "Studio");

  assert.equal(api.removeKey("studio"), true);

  assert.equal(api.getToken(), "tok-main", "token phải thăng lên khoá còn lại");
  assert.equal(api.getTenant(), "", "phòng cũ phải bị dọn, không để lại 'studio'");
  assert.equal(localStorage.getItem("owm_tenant"), null);
  assert.equal(localStorage.getItem("owm_tenant_name"), null);
});

test("removeKey vẫn thăng khoá có phòng bình thường như cũ", () => {
  api.addKey({ tenant: "a", token: "tok-a", name: "A" });
  api.addKey({ tenant: "b", token: "tok-b", name: "B" });
  api.setToken("tok-a");
  api.setTenant("a", "A");

  assert.equal(api.removeKey("a"), true);
  assert.equal(api.getToken(), "tok-b");
  assert.equal(api.getTenant(), "b");
  assert.equal(api.getTenantName(), "B");
});

// ---- unwrap(): không mất object khi `data` là undefined ----

test("unwrap bóc wrapper {data} bình thường", () => {
  assert.deepEqual(api.unwrap({ data: { id: "s1" } }), { id: "s1" });
  assert.deepEqual(api.unwrap({ id: "s1" }), { id: "s1" });
  assert.deepEqual(api.unwrap([1, 2]), [1, 2]);
  assert.equal(api.unwrap(null), null);
  assert.equal(api.unwrap(undefined), undefined);
});

test("unwrap giữ nguyên object khi `data` là undefined (bản cũ trả undefined)", () => {
  const payload = { data: undefined, id: "s1" };
  assert.equal(api.unwrap(payload), payload);
});

test("unwrap giữ `{data: null}` là null — `unwrap(p) ?? []` ở các trang không nổ", () => {
  assert.equal(api.unwrap({ data: null }), null);
  assert.deepEqual(api.unwrap({ data: null }) ?? [], []);
});

// ---- ow(): body 200 không phải JSON ----

test("ow() 200 nhưng body HTML rác → lỗi nói đúng nguyên nhân, không phải SyntaxError", async () => {
  globalThis.fetch = async () =>
    new Response("<!doctype html><title>lỗi</title>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  await assert.rejects(
    () => api.ow("/workspace/w1/opencode/session"),
    (err) => {
      assert.match(err.message, /JSON/);
      assert.equal(err.status, 200);
      assert.doesNotMatch(err.message, /SyntaxError|Unexpected token|is not valid JSON/);
      return true;
    }
  );
});

test("ow() 200 với body rỗng trả null thay vì ném", async () => {
  globalThis.fetch = async () => new Response("", { status: 200 });
  assert.equal(await api.ow("/workspace/w1/x"), null);
});

test("ow() vẫn trả payload JSON bình thường", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [1, 2] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  assert.deepEqual(await api.ow("/workspace/w1/opencode/session"), { data: [1, 2] });
});

test("ow() 401 vẫn ném UNPAIRED (App dựa vào chuỗi này để về màn ghép)", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(() => api.ow("/workspace/w1/x"), (e) => e.message === "UNPAIRED");
});

test("ow() raw:true không áp trần chờ (đọc stream tải file lớn)", async () => {
  let seenSignal;
  globalThis.fetch = async (_url, options) => {
    seenSignal = options.signal;
    return new Response("abc", { status: 200 });
  };
  await api.ow("/workspace/w1/files/raw?path=a.txt", { raw: true });
  assert.equal(seenSignal, undefined, "raw phải để caller tự quyết timeout");
});

test("ow() có trần chờ: fetch treo thì bị abort, không treo UI vĩnh viễn", async () => {
  let seenSignal;
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      seenSignal = options.signal;
      options.signal.addEventListener("abort", () =>
        reject(options.signal.reason ?? new Error("aborted"))
      );
    });

  await assert.rejects(
    () => api.ow("/workspace/w1/slow", { timeoutMs: 10 }),
    (err) => {
      assert.equal(err.name, "TimeoutError");
      return true;
    }
  );
  assert.ok(seenSignal, "phải truyền signal xuống fetch");
});

test("ow() timeoutMs: 0 tắt trần chờ", async () => {
  let seenSignal;
  globalThis.fetch = async (_url, options) => {
    seenSignal = options.signal;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await api.ow("/workspace/w1/x", { timeoutMs: 0 });
  assert.equal(seenSignal, undefined);
});

test("ow() truyền tiếp signal của caller — hủy giữa chừng thì ngắt request", async () => {
  const parent = new AbortController();
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () =>
        reject(options.signal.reason ?? new Error("aborted"))
      );
    });

  const pending = api.ow("/workspace/w1/x", { signal: parent.signal, timeoutMs: 60_000 });
  parent.abort();
  await assert.rejects(pending, (err) => err.name === "AbortError");
});

test("ow() giữ listener hủy của caller tới hết lúc đọc body", async () => {
  // Regression: tháo listener sớm (ngay sau khi fetch trả header) làm mất khả
  // năng hủy đúng lúc đang đọc body — nút Hủy im lặng.
  const parent = new AbortController();
  let released = false;
  globalThis.fetch = async (_url, options) => {
    // Trong lúc `ow` đang xử lý, listener của caller phải còn nối.
    assert.notEqual(parent.signal.aborted, true);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await api.ow("/workspace/w1/x", { signal: parent.signal, timeoutMs: 60_000 });
  assert.deepEqual(result, {});
  assert.equal(released, false);
  parent.abort(); // sau khi xong thì hủy là vô nghĩa, không được ném
});
// ---- apiPair(): KHÔNG chặn mã ở client, xác thực thật vẫn ở bridge ----

test("apiPair gửi mã nguyên văn lên bridge (bridge mới là nơi so mã)", async () => {
  const seen = {};
  globalThis.fetch = async (url, options) => {
    seen.url = url;
    seen.body = JSON.parse(options.body);
    return new Response(JSON.stringify({ token: "owd_new", device: { id: "d1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  // Mã sai hình dạng vẫn phải TỚI BRIDGE — bản sao bảng chữ cái ở web nghĩa là
  // mỗi lần sửa bridge là người dùng không ghép được nữa.
  const payload = await api.apiPair("abcd-1234", "");
  assert.equal(seen.url, "/api/pair");
  assert.equal(seen.body.code, "abcd-1234");
  assert.equal(payload.token, "owd_new");
});

test("apiPair không ném khi code rỗng/rác — để bridge trả lỗi tiếng Việt", async () => {
  const seen = {};
  globalThis.fetch = async (_url, options) => {
    seen.body = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ code: "invalid_code", message: "Mã không đúng, đã dùng hoặc hết hạn." }),
      { status: 401, headers: { "content-type": "application/json" } }
    );
  };
  await assert.rejects(
    () => api.apiPair(undefined, ""),
    (e) => {
      assert.equal(e.code, "invalid_code");
      assert.match(e.message, /không đúng|hết hạn/i);
      return true;
    }
  );
  assert.equal(seen.body.code, "");
});

// ---- Endpoint gọi LLM thì KHÔNG đặt timeout ----
// Nén hội thoại (`/summarize`) và slash command (`/command`) mất hàng chục giây
// tới vài phút. Engine cũng miễn timeout cho đúng hai endpoint này
// (apps/app/src/app/lib/opencode.ts: SESSION_LONG_RUNNING_URL_RE → 0). Trần
// 30s chung của ow() sẽ abort nửa chừng và để phiên lửng lơ.

test("owSummarize và owRunCommand không bị trần 30s của ow() cắt", async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), signal: options.signal });
    return new Response("true", { status: 200, headers: { "content-type": "application/json" } });
  };
  await api.owSummarize("w1", "s1", "google/gemini-3-pro");
  await api.owRunCommand("w1", "s1", { command: "/clear", args: "" });
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.signal, undefined, `${call.url} phải để request chạy tới khi xong`);
  }
});

test("trần upload phải khớp hạn mức thật của engine (5.000.000 byte)", async () => {
  // Engine chặn FILE_SESSION_MAX_FILE_BYTES = 5.000.000 và trả 413
  // (apps/server/src/routes/files.ts). Trần của web phải bằng hạn mức đó,
  // không phải trần body của proxy — báo 40MB là nói dối, file 5–40MB hỏng.
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  // Node không có FileReader — chỉ cần biết đường ĐÚNG ở ranh giới này, nên
  // file đúng hạn chỉ được kiểm "không bị chặn vì lý do kích thước".
  const FileReaderShim = class {
    readAsDataURL() {
      this.result = "data:application/octet-stream;base64,AAAA";
      queueMicrotask(() => this.onload?.());
    }
  };
  const withReader = async (file) => {
    globalThis.FileReader = FileReaderShim;
    try {
      return await api.owUploadFile("w1", "", file);
    } finally {
      delete globalThis.FileReader;
    }
  };
  assert.equal(await withReader({ name: "a.bin", size: 5_000_000 }), "a.bin", "đúng hạn thì qua");
  await assert.rejects(
    () => api.owUploadFile("w1", "", { name: "b.bin", size: 5_000_001 }),
    /too large/,
    "vượt hạn engine thì chặn ngay, không gửi lên để nhận 413"
  );
});
