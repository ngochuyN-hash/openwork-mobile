// Unit tests for the ow() error contract, sseUrl() and filenameFromDisposition()
// in web/src/api.js (the strings every page relies on — e.g. app.jsx matches
// error.message === "UNPAIRED" to flip back to the pairing screen).
//
// fetch is replaced with a stub returning REAL Response objects so the JSON
// parsing / error paths in ow() run unmodified. Browser globals are shimmed
// before the dynamic import; api.js has no import-time side effects.
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

// ---- ow() error contract ----

test("ow() throws Error('UNPAIRED') on 401", async () => {
  globalThis.fetch = async () => respond(401, { message: "unauthorized" });
  await assert.rejects(
    () => api.ow("/workspace/w1/sessions"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "UNPAIRED");
      return true;
    }
  );
});

test("ow() on non-OK sets error.status and uses payload.message when present", async () => {
  globalThis.fetch = async () => respond(404, { message: "Workspace không tồn tại" });
  await assert.rejects(
    () => api.ow("/workspace/missing/files"),
    (err) => {
      assert.equal(err.message, "Workspace không tồn tại");
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test("ow() on non-OK without a JSON message falls back to 'HTTP <status>'", async () => {
  globalThis.fetch = async () => respond(500, "boom");
  await assert.rejects(
    () => api.ow("/workspace/w1/x"),
    (err) => {
      assert.equal(err.message, "HTTP 500");
      assert.equal(err.status, 500);
      return true;
    }
  );
});

test("ow() returns null on 204", async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.ow("/workspace/w1/opencode/session/s1", { method: "DELETE" }), null);
});

test("ow() returns the parsed JSON payload on success", async () => {
  globalThis.fetch = async () => respond(200, { ok: 1, list: [1, 2] });
  assert.deepEqual(await api.ow("/workspace/w1/sessions"), { ok: 1, list: [1, 2] });
});

test("ow() sends the Bearer token, tenant header and JSON body", async () => {
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return respond(200, { ok: true });
  };
  api.setToken("tok-ow");
  api.setTenant("room-9");

  await api.ow("/workspace/w1/files/raw", { method: "POST", body: { path: "a.txt", dataBase64: "aGk=" } });

  assert.equal(seen.url, "/api/ow/workspace/w1/files/raw");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers.authorization, "Bearer tok-ow");
  assert.equal(seen.options.headers["x-owm-tenant"], "room-9");
  assert.deepEqual(JSON.parse(seen.options.body), { path: "a.txt", dataBase64: "aGk=" });
});

// ---- apiPair() error contract ----

test("apiPair keeps the machine-readable code (tenant_required) on the thrown error", async () => {
  globalThis.fetch = async () => respond(400, { code: "tenant_required", message: "Thiếu phòng (tenant)" });
  await assert.rejects(
    () => api.apiPair("ABCD1234", ""),
    (err) => {
      assert.equal(err.message, "Thiếu phòng (tenant)");
      assert.equal(err.status, 400);
      assert.equal(err.code, "tenant_required");
      return true;
    }
  );
});

test("apiPair falls back to 'HTTP <status>' + empty code when the body is not JSON", async () => {
  globalThis.fetch = async () => respond(502, "bad gateway");
  await assert.rejects(
    () => api.apiPair("ABCD1234", ""),
    (err) => {
      assert.equal(err.message, "HTTP 502");
      assert.equal(err.code, "");
      return true;
    }
  );
});

test("apiPair success returns the payload and writes the keyring entry", async () => {
  globalThis.fetch = async () => respond(200, { token: "owd_tok", device: { id: "d1" } });
  const payload = await api.apiPair("ABCD1234", "");
  assert.deepEqual(payload, { token: "owd_tok", device: { id: "d1" } });
  assert.equal(JSON.parse(localStorage.getItem("owm_keys"))[0].token, "owd_tok");
});

// ---- blobUrlFor(): token KHONG bao gio len URL ----
//
// Cu dua biet: bo `sseUrl()` (dan `?_t=<token>`) khoi api.js. Token tren URL
// lo vao history trinh duyet, vao Referer cua moi request sau, vao log cua
// worker/cloudflared/bridge. Bay moi request deu di bang header; `<img>`/`<iframe>`
// thi fetch bang header roi gan `blob:`.

test("blobUrlFor fetch bang header Authorization, KHONG dua token len URL", async () => {
  api.setToken("tok-1");
  api.setTenant("room-1");
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 });
  };
  globalThis.URL.createObjectURL = () => "blob:fake-1";
  globalThis.URL.revokeObjectURL = () => {};

  const url = await api.blobUrlFor("ws_1", "charts/a b.png");
  assert.equal(url, "blob:fake-1");
  assert.equal(seen.length, 1);
  // URL sach: chi con duong dan file, khong co `_t`/`_m`/token.
  assert.match(seen[0].url, /^\/api\/ow\/workspace\/ws_1\/files\/raw\?path=/);
  assert.doesNotMatch(seen[0].url, /_t=|_m=|tok-1/);
  // Chinh token di bang header.
  assert.equal(seen[0].headers.authorization, "Bearer tok-1");
  assert.equal(seen[0].headers["x-owm-tenant"], "room-1");
});

test("blobUrlFor tra chuoi rong khi thieu wsId/path, khong fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("", { status: 200 });
  };
  assert.equal(await api.blobUrlFor("", "a.png"), "");
  assert.equal(await api.blobUrlFor("ws_1", ""), "");
  assert.equal(calls, 0);
});

test("blobUrlFor nem loi co message cua engine khi raw tra loi", async () => {
  api.setToken("tok-2");
  globalThis.fetch = async () => respond(404, { code: "file_not_found", message: "Khong thay file" });
  await assert.rejects(() => api.blobUrlFor("ws_1", "x.png"), /Khong thay file/);
});

test("removeKey xoa cache blob — bytes cua may da go khong con y nghia", async () => {
  api.setToken("tok-3");
  globalThis.URL.createObjectURL = () => "blob:fake-2";
  const revoked = [];
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([9])]), { status: 200 });

  await api.blobUrlFor("ws_1", "keep.png");
  api.removeKey(api.getTenant() || "room-1");
  // Cache đã bị xoá nên lần sau phải fetch lại, và URL cũ phải được thu hồi.
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(new Blob([new Uint8Array([9])]), { status: 200 });
  };
  await api.blobUrlFor("ws_1", "keep.png");
  assert.equal(calls, 1, "phai tai lai sau khi cache bi xoa");
});

// ---- filenameFromDisposition() ----

test("filenameFromDisposition prefers filename* UTF-8 over plain filename", () => {
  assert.equal(
    api.filenameFromDisposition(`attachment; filename="backup.zip"; filename*=UTF-8''b%C3%A1o%20c%C3%A1o.zip`),
    "báo cáo.zip"
  );
});

test("filenameFromDisposition falls back to the raw value when decoding fails", () => {
  // "%E0%A4%" is a truncated UTF-8 sequence — decodeURIComponent throws.
  assert.equal(api.filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%.zip"), "%E0%A4%.zip");
});

test("filenameFromDisposition reads plain filename (quoted or not) and empty headers", () => {
  assert.equal(api.filenameFromDisposition('attachment; filename="report.pdf"'), "report.pdf");
  assert.equal(api.filenameFromDisposition("attachment; filename=report.pdf"), "report.pdf");
  assert.equal(api.filenameFromDisposition(""), "");
  assert.equal(api.filenameFromDisposition(undefined), "");
});
