// Unit tests cho nhóm hàm "thao tác trên MỘT session" mới thêm vào
// web/src/api.js: owRenameSession · owPrompt · owSummarize · owShareSession/
// owUnshareSession. Các lib thuần (session-rename, model-behavior,
// session-compact) đã có test riêng; test ở đây khoá HỢP ĐỒNG WIRE —
// method, path, body — vì đó là chỗ sai thì hỏng mà không ai thấy.
//
// fetch thay bằng stub trả Response thật (giống api-contract.test.js).
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

/** Bắt request đầu tiên, trả về {url, method, body, headers}. */
function capture(status = 200, payload = { ok: true }) {
  const seen = {};
  globalThis.fetch = async (url, options = {}) => {
    seen.url = url;
    seen.method = options.method ?? "GET";
    seen.body = options.body === undefined ? undefined : JSON.parse(options.body);
    seen.headers = options.headers ?? {};
    // 204 phải có body null — Response của Node không nhận body với 204.
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return seen;
}

function failIfCalled() {
  globalThis.fetch = async () => {
    throw new Error("fetch phải KHÔNG được gọi");
  };
}

// ---- Đổi tên phiên: PATCH /session/:id ----

test("owRenameSession PATCH đúng path và gửi title đã dẹp khoảng trắng", async () => {
  const seen = capture(200, { data: { id: "s1", title: "sửa bug login" } });
  const result = await api.owRenameSession("w 1", "s1", "  sửa bug\n  login  ");
  assert.equal(seen.url, "/api/ow/workspace/w%201/opencode/session/s1");
  assert.equal(seen.method, "PATCH");
  assert.deepEqual(seen.body, { title: "sửa bug login" });
  // unwrap .data: trả về đúng session, không phải envelope
  assert.equal(result.title, "sửa bug login");
});

test("owRenameSession chặn tên rỗng NGAY ở client, không tốn request", async () => {
  failIfCalled();
  await assert.rejects(
    () => api.owRenameSession("w1", "s1", "   "),
    (err) => {
      assert.equal(err.message, "Session name cannot be empty.");
      return true;
    }
  );
});

test("owRenameSession chặn tên quá trần, nói rõ con số", async () => {
  failIfCalled();
  await assert.rejects(
    () => api.owRenameSession("w1", "s1", "x".repeat(200)),
    (err) => {
      assert.match(err.message, /120 characters/);
      return true;
    }
  );
});

// ---- Gửi prompt (kể cả tin xen giữa lúc agent đang chạy) ----

test("owPrompt POST prompt_async với model + variant, bỏ agent rỗng", async () => {
  const seen = capture(204);
  await api.owPrompt("w1", "s1", {
    text: "sửa tiếp",
    model: "anthropic/claude",
    variants: [{ id: "high" }],
    effort: "high",
    agent: "",
  });
  assert.equal(seen.url, "/api/ow/workspace/w1/opencode/session/s1/prompt_async");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, {
    parts: [{ type: "text", text: "sửa tiếp" }],
    model: { providerID: "anthropic", modelID: "claude" },
    variant: "high",
  });
});

test("owPrompt với model Codex gửi reasoning_effort và KHÔNG gửi variant", async () => {
  const seen = capture(204);
  await api.owPrompt("w1", "s1", {
    text: "x",
    model: "openai/gpt-5-codex",
    effort: "medium",
    variants: [{ id: "high" }],
  });
  assert.deepEqual(seen.body, {
    parts: [{ type: "text", text: "x" }],
    model: { providerID: "openai", modelID: "gpt-5-codex" },
    reasoning_effort: "medium",
  });
  assert.equal("variant" in seen.body, false);
});

test("owPrompt không gửi mức suy luận khi model không có variant nào — engine tự chọn", async () => {
  const seen = capture(204);
  await api.owPrompt("w1", "s1", { text: "x", model: "anthropic/claude", effort: "high" });
  assert.deepEqual(seen.body, {
    parts: [{ type: "text", text: "x" }],
    model: { providerID: "anthropic", modelID: "claude" },
  });
});

test("owPrompt chỉ gửi agent khi có tên; agent sai dạng thì model bị bỏ, không gửi tin ma", async () => {
  const seen = capture(204);
  await api.owPrompt("w1", "s1", { text: "x", model: "không-có-dấu-gạch", agent: " build " });
  assert.deepEqual(seen.body, { parts: [{ type: "text", text: "x" }], agent: "build" });
});

// ---- Nén hội thoại: POST /session/:id/summarize ----

test("owSummarize POST summarize với providerID/modelID tách riêng", async () => {
  const seen = capture(200, { ok: true });
  await api.owSummarize("w1", "s1", "anthropic/claude");
  assert.equal(seen.url, "/api/ow/workspace/w1/opencode/session/s1/summarize");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { providerID: "anthropic", modelID: "claude" });
});

test("owSummarize chưa chọn model thì nói rõ, không gửi request", async () => {
  failIfCalled();
  await assert.rejects(
    () => api.owSummarize("w1", "s1", ""),
    (err) => {
      assert.match(err.message, /Select a model/);
      return true;
    }
  );
});

// ---- Chia sẻ: POST/DELETE /session/:id/share ----

test("owShareSession POST /share không gửi body", async () => {
  const seen = capture(200, { id: "s1", share: { url: "https://s.op/" } });
  const payload = await api.owShareSession("w1", "s1");
  assert.equal(seen.url, "/api/ow/workspace/w1/opencode/session/s1/share");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, undefined);
  // Trả NGUYÊN payload: lib/session-share bóc Session.share.url
  assert.equal(payload.share.url, "https://s.op/");
});

test("owUnshareSession DELETE /share không gửi body", async () => {
  const seen = capture(200, { id: "s1" });
  await api.owUnshareSession("w1", "s1");
  assert.equal(seen.url, "/api/ow/workspace/w1/opencode/session/s1/share");
  assert.equal(seen.method, "DELETE");
  assert.equal(seen.body, undefined);
});

test("owShareSession ném lỗi tiếng Việt của máy khi phiên không tồn tại", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "Không tìm thấy phiên" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    () => api.owShareSession("w1", "s1"),
    (err) => {
      assert.equal(err.message, "Không tìm thấy phiên");
      assert.equal(err.status, 404);
      return true;
    }
  );
});