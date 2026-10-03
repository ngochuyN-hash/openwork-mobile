// Unit tests cho phần "hỏi người dùng bản OpenWork" ở web: apiOpenWorkPath()
// (POST /api/openwork/path) và candidates mà apiWakeOpenWork() giữ lại trên error.
// fetch thay bằng stub trả Response thật nên nhánh JSON/lỗi trong api.js chạy y như
// thật. Shim trình duyệt + env phải có TRƯỚC khi import (api.js không side-effect
// lúc import nên import động là an toàn).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

// House rule: tests never touch a real bridge / openwork data directory.
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

function respond(status, body, headers = {}) {
  if (body === undefined) return new Response(null, { status, headers });
  if (typeof body === "string") return new Response(body, { status, headers });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ---- apiOpenWorkPath(): body/header đúng như bridge chờ ----

test("apiOpenWorkPath POST /api/openwork/path với body {path} và header chìa + phòng", async () => {
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return respond(200, { ok: true, openwork: { found: true, exe: "C:/OpenWork/OpenWork.exe" } });
  };
  api.setToken("tok-ow");
  api.setTenant("room-9");

  await api.apiOpenWorkPath("C:\\OpenWork\\OpenWork.exe");

  assert.equal(seen.url, "/api/openwork/path");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers["content-type"], "application/json");
  assert.equal(seen.options.headers.authorization, "Bearer tok-ow");
  assert.equal(seen.options.headers["x-owm-tenant"], "room-9");
  assert.deepEqual(JSON.parse(seen.options.body), { path: "C:\\OpenWork\\OpenWork.exe" });
});

test("apiOpenWorkPath cắt khoảng trắng thừa quanh path trước khi gửi", async () => {
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = options;
    return respond(200, { ok: true });
  };
  await api.apiOpenWorkPath("  C:\\OpenWork\\OpenWork.exe  ");
  assert.deepEqual(JSON.parse(seen.body), { path: "C:\\OpenWork\\OpenWork.exe" });
});

test("apiOpenWorkPath trả nguyên payload (kể cả openwork) để vẽ lại UI", async () => {
  globalThis.fetch = async () =>
    respond(200, {
      ok: true,
      openwork: { found: true, exe: "C:/OpenWork/OpenWork.exe", version: "0.18.54", source: "config" },
    });
  const payload = await api.apiOpenWorkPath("C:/OpenWork/OpenWork.exe");
  assert.deepEqual(payload.openwork, {
    found: true,
    exe: "C:/OpenWork/OpenWork.exe",
    version: "0.18.54",
    source: "config",
  });
});

// ---- apiOpenWorkPath(): lỗi phải hiện nguyên văn message của bridge ----

test("apiOpenWorkPath ném đúng message tiếng Việt của bridge khi 400", async () => {
  globalThis.fetch = async () =>
    respond(400, { message: "Đường dẫn không tồn tại hoặc không phải file: C:\\hien.mp4" });
  await assert.rejects(
    () => api.apiOpenWorkPath("C:\\hien.mp4"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Đường dẫn không tồn tại hoặc không phải file: C:\\hien.mp4");
      return true;
    }
  );
});

test("apiOpenWorkPath ném UNPAIRED khi 401 để App về màn ghép nối", async () => {
  globalThis.fetch = async () => respond(401, { message: "unauthorized" });
  await assert.rejects(
    () => api.apiOpenWorkPath("C:/OpenWork/OpenWork.exe"),
    (err) => {
      assert.equal(err.message, "UNPAIRED");
      return true;
    }
  );
});

test("apiOpenWorkPath rơi về 'path <status>' khi body lỗi không phải JSON", async () => {
  globalThis.fetch = async () => respond(500, "boom");
  await assert.rejects(
    () => api.apiOpenWorkPath("C:/OpenWork/OpenWork.exe"),
    (err) => {
      assert.equal(err.message, "path 500");
      return true;
    }
  );
});

test("apiOpenWorkPath gửi body JSON rỗng an toàn khi path không phải chuỗi", async () => {
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = options;
    return respond(200, { ok: true });
  };
  await api.apiOpenWorkPath(undefined);
  assert.deepEqual(JSON.parse(seen.body), { path: "" });
});

// ---- apiWakeOpenWork(): candidates không bị vứt đi ----

test("apiWakeOpenWork giữ candidates của bridge trên error để màn Cài đặt chọn đường dẫn", async () => {
  globalThis.fetch = async () =>
    respond(404, {
      code: "openwork_exe_not_found",
      message: "Không tìm thấy OpenWork.exe",
      candidates: ["C:/OpenWork/OpenWork.exe", "C:/Program Files/OpenWork/OpenWork.exe"],
    });
  await assert.rejects(
    () => api.apiWakeOpenWork(),
    (err) => {
      assert.equal(err.message, "Không tìm thấy OpenWork.exe");
      assert.equal(err.status, 404);
      assert.deepEqual(err.candidates, [
        "C:/OpenWork/OpenWork.exe",
        "C:/Program Files/OpenWork/OpenWork.exe",
      ]);
      return true;
    }
  );
});

test("apiWakeOpenWork để candidates là mảng rỗng khi bridge không trả kèm", async () => {
  globalThis.fetch = async () => respond(500, { message: "Bật OpenWork lỗi" });
  await assert.rejects(
    () => api.apiWakeOpenWork(),
    (err) => {
      assert.deepEqual(err.candidates, []);
      return true;
    }
  );
});