// Unit tests cho nhóm API "máy & ghép nối" thêm vào web/src/api.js:
// apiPairingCode · apiRestartTunnel · apiSetMachineName · owEngineReloadAll.
// Khoá HỢP ĐỒNG WIRE (method, path, body) — sai chỗ này thì hỏng mà không ai
// thấy, vì bridge/desktop đã chạy sẵn các route này từ trước.
//
// fetch thay bằng stub trả Response thật (giống api-session-actions.test.js).
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

// ---- Mã ghép đang sống: GET /api/pairing-code ----

test("apiPairingCode GET đúng path và trả nguyên payload bridge", async () => {
  const seen = capture(200, {
    ok: true,
    code: "ABCD2345",
    codeFormatted: "ABCD-2345",
    secondsLeft: 1800,
    pairUrl: "https://x/#p=ABCD2345",
  });
  const result = await api.apiPairingCode();
  assert.equal(seen.url, "/api/pairing-code");
  assert.equal(seen.method, "GET");
  assert.equal(result.codeFormatted, "ABCD-2345");
});

test("apiPairingCode 401 ném UNPAIRED cho màn Settings đọc cờ", async () => {
  capture(401, { code: "unauthorized" });
  await assert.rejects(() => api.apiPairingCode(), (e) => e.message === "UNPAIRED");
});

// ---- Restart tunnel: POST /api/tunnel/restart ----

test("apiRestartTunnel POST đúng path, trả state tunnel mới", async () => {
  const seen = capture(200, { ok: true, tunnel: { url: "https://mới.example", since: 1 } });
  const result = await api.apiRestartTunnel();
  assert.equal(seen.url, "/api/tunnel/restart");
  assert.equal(seen.method, "POST");
  assert.equal(result.tunnel.url, "https://mới.example");
});

test("apiRestartTunnel 409 ném đúng message tiếng Việt của bridge", async () => {
  capture(409, { code: "tunnel_inactive", message: "Tunnel không chạy (OPENWORK_BRIDGE_TUNNEL=0 hoặc đang restart dở)." });
  await assert.rejects(
    () => api.apiRestartTunnel(),
    (e) => e.message.includes("Tunnel không chạy")
  );
});

// ---- Đổi tên máy: POST /api/machine/name ----

test("apiSetMachineName POST body name đã dẹp khoảng trắng", async () => {
  const seen = capture(200, { ok: true, machineName: "PC phòng khách" });
  const result = await api.apiSetMachineName("  PC phòng khách  ");
  assert.equal(seen.url, "/api/machine/name");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { name: "PC phòng khách" });
  assert.equal(result.machineName, "PC phòng khách");
});

test("apiSetMachineName chặn tên rỗng NGAY ở client, không tốn request", async () => {
  failIfCalled();
  await assert.rejects(() => api.apiSetMachineName("   "), (e) => e.message === "Machine name is empty.");
});

// ---- Nạp lại engine: POST /workspace/:id/engine/reload ----

test("owEngineReloadAll nạp TUẦN TỰ đúng path, giữ thứ tự kết quả", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true, reloadedAt: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const results = await api.owEngineReloadAll(["ws_1", "ws 2"]);
  assert.deepEqual(
    calls.map((c) => [c.url, c.method]),
    [
      ["/api/ow/workspace/ws_1/engine/reload", "POST"],
      ["/api/ow/workspace/ws%202/engine/reload", "POST"],
    ]
  );
  assert.deepEqual(results, [
    { wsId: "ws_1", ok: true },
    { wsId: "ws 2", ok: true },
  ]);
});

test("owEngineReloadAll 1 workspace lỗi không hỏng cả lô", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("bad")) {
      return new Response(JSON.stringify({ message: "engine bận" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const results = await api.owEngineReloadAll(["ok_1", "bad_2", "ok_3"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error, "engine bận");
  assert.equal(results[2].ok, true);
});

test("owEngineReloadAll danh sách rỗng/trùng lặp sạch — không gọi fetch", async () => {
  failIfCalled();
  assert.deepEqual(await api.owEngineReloadAll([]), []);
  assert.deepEqual(await api.owEngineReloadAll(["", null, "  "]), []);
});
