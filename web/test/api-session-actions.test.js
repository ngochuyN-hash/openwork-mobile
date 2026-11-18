// Unit tests cho nhóm hàm "thao tác trên MỘT session" trong web/src/api.js:
// owRenameSession · owPrompt · owSummarize · owShareSession/owUnshareSession.
// Các lib thuần (session-rename, model-behavior, session-compact) đã có test
// riêng; test ở đây khoá HỢP ĐỒNG WIRE với engine v2 — method, path, body —
// vì đó là chỗ sai thì hỏng mà không ai thấy.
//
// Engine v2 tách model/agent ra khỏi prompt: một lượt gửi = POST /model (nếu
// có model), POST /agent (nếu có agent), rồi POST /prompt. Vì vậy các test
// owPrompt ở đây bắt CẢ DÃY request, không chỉ request đầu.
//
// fetch thay bằng stub trả Response thật (giống api-contract.test.js).
// House rule: không chạm bridge / thư mục dữ liệu thật của máy.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installBrowserShim, createStorageShim } from "./helpers/shim.js";

// House rule: tests never touch a real bridge / openwork data directory.
// Browser + data-dir shim dùng chung — web/test/helpers/shim.js.
installBrowserShim();

// Round 4 tách api.js: unwrap dời sang lib/format — gộp lại một namespace.
const api = {
  ...(await import("../src/lib/format.js")),
  ...(await import("../src/api.js")),
};

beforeEach(() => {
  globalThis.localStorage = createStorageShim();
});

/** Mount engine v2 của workspace qua proxy của openwork-server. */
const V2 = (wsId) => `/api/ow/workspace/${encodeURIComponent(wsId)}/opencode2/api`;

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

/** Bắt CẢ DÃY request (một lượt gửi v2 = nhiều call) theo đúng thứ tự. */
function captureAll(status = 200, payload = { ok: true }) {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      url,
      method: options.method ?? "GET",
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return requests;
}

function failIfCalled() {
  globalThis.fetch = async () => {
    throw new Error("fetch phải KHÔNG được gọi");
  };
}

// ---- Đổi tên phiên: PATCH /api/session/:id ----

test("owRenameSession PATCH đúng path và gửi title đã dẹp khoảng trắng", async () => {
  const seen = capture(200, { data: { id: "s1", title: "sửa bug login" } });
  const result = await api.owRenameSession("w 1", "s1", "  sửa bug\n  login  ");
  assert.equal(seen.url, `${V2("w 1")}/session/s1`);
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

// ---- Gửi prompt: POST /model → POST /agent → POST /prompt ----

test("owPrompt đặt model (kèm variant) rồi mới gửi prompt; agent rỗng thì bỏ qua", async () => {
  const reqs = captureAll(200, { ok: true });
  await api.owPrompt("w1", "s1", {
    text: "sửa tiếp",
    model: "anthropic/claude",
    variants: [{ id: "high" }],
    effort: "high",
    agent: "",
  });
  assert.equal(reqs.length, 2, "không có agent -> đúng 2 request");
  assert.equal(reqs[0].url, `${V2("w1")}/session/s1/model`);
  assert.equal(reqs[0].method, "POST");
  assert.deepEqual(reqs[0].body, {
    model: { id: "claude", providerID: "anthropic", variant: "high" },
  });
  assert.equal(reqs[1].url, `${V2("w1")}/session/s1/prompt`);
  assert.equal(reqs[1].method, "POST");
  // v2 tách model ra khỏi prompt: body chỉ còn text.
  assert.deepEqual(reqs[1].body, { text: "sửa tiếp" });
});

test("owPrompt với model Codex: reasoning_effort quy về variant của catalog, không gửi field lạ", async () => {
  // Codex dùng effort "medium" nhưng catalog chỉ khai variant "high" -> không
  // đoán bừa: model được đặt KHÔNG kèm variant.
  const reqs = captureAll(200, { ok: true });
  await api.owPrompt("w1", "s1", {
    text: "x",
    model: "openai/gpt-5-codex",
    effort: "medium",
    variants: [{ id: "high" }],
  });
  assert.deepEqual(reqs[0].body, { model: { id: "gpt-5-codex", providerID: "openai" } });
  assert.equal("variant" in reqs[0].body.model, false);
  assert.equal("reasoning_effort" in reqs[0].body.model, false, "field v1, v2 không nhận");
  assert.deepEqual(reqs[1].body, { text: "x" });
});

test("owPrompt không gửi mức suy luận khi model không có variant nào — engine tự chọn", async () => {
  const reqs = captureAll(200, { ok: true });
  await api.owPrompt("w1", "s1", { text: "x", model: "anthropic/claude", effort: "high" });
  assert.deepEqual(reqs[0].body, { model: { id: "claude", providerID: "anthropic" } });
  assert.deepEqual(reqs[1].body, { text: "x" });
});

test("owPrompt chỉ gửi agent khi có tên; model sai dạng thì bỏ hẳn bước /model", async () => {
  const reqs = captureAll(200, { ok: true });
  await api.owPrompt("w1", "s1", { text: "x", model: "không-có-dấu-gạch", agent: " build " });
  assert.equal(reqs.length, 2, "model rác -> không có /model");
  assert.equal(reqs[0].url, `${V2("w1")}/session/s1/agent`);
  assert.deepEqual(reqs[0].body, { agent: "build" });
  assert.equal(reqs[1].url, `${V2("w1")}/session/s1/prompt`);
  assert.deepEqual(reqs[1].body, { text: "x" });
});

test("owPrompt vẫn gửi prompt khi không có model/agent — không chặn tin nhắn", async () => {
  const reqs = captureAll(200, { ok: true });
  await api.owPrompt("w1", "s1", { text: "chỉ text" });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, `${V2("w1")}/session/s1/prompt`);
  assert.deepEqual(reqs[0].body, { text: "chỉ text" });
});

// ---- Nén hội thoại: POST /api/session/:id/compact ----

test("owSummarize POST compact, body rỗng — model lấy từ phiên", async () => {
  const seen = capture(200, { ok: true });
  await api.owSummarize("w1", "s1", "anthropic/claude");
  assert.equal(seen.url, `${V2("w1")}/session/s1/compact`);
  assert.equal(seen.method, "POST");
  // v2 nén bằng model ĐANG đặt trên phiên (owPrompt đặt trước mỗi lượt).
  assert.deepEqual(seen.body, {});
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

// ---- Chia sẻ: engine v2 không có route share ----

test("owShareSession từ chối ngay ở client, không gửi request", async () => {
  failIfCalled();
  await assert.rejects(
    () => api.owShareSession("w1", "s1"),
    (err) => {
      assert.equal(err.message, "Share links are not supported on this engine.");
      return true;
    }
  );
});

test("owUnshareSession từ chối ngay ở client, không gửi request", async () => {
  failIfCalled();
  await assert.rejects(
    () => api.owUnshareSession("w1", "s1"),
    (err) => {
      assert.equal(err.message, "Share links are not supported on this engine.");
      return true;
    }
  );
});
