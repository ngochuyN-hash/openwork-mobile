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

// ---- sseUrl() ----

test("sseUrl appends _t and _m, joining with & when the path already has a query", () => {
  api.setToken("tok-1");
  api.setTenant("room-1");
  assert.equal(api.sseUrl("/x?a=1"), "/api/ow/x?a=1&_t=tok-1&_m=room-1");
});

test("sseUrl uses ? on a query-less path and omits _m when no tenant is set", () => {
  api.setToken("tok-2");
  api.clearTenant();
  assert.equal(api.sseUrl("/x"), "/api/ow/x?_t=tok-2");
});

test("sseUrl percent-encodes the token and the tenant", () => {
  api.setToken("t k/?=&");
  api.setTenant("phòng 1");
  assert.equal(
    api.sseUrl("/ws"),
    `/api/ow/ws?_t=${encodeURIComponent("t k/?=&")}&_m=${encodeURIComponent("phòng 1")}`
  );
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
