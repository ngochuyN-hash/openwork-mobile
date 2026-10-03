// Unit tests for the keyring ("bundle of machine keys") and the one-time
// migration in web/src/api.js.
//
// The module must stay import-safe in bare Node: no localStorage access at
// import time (the old migrateKeys IIFE used to run right at import, which made
// the module untestable). The browser globals are shimmed here BEFORE the
// dynamic import below, and api.js itself never touches them at top level.
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

const readKeys = () => JSON.parse(localStorage.getItem("owm_keys") ?? "null");

beforeEach(() => {
  globalThis.localStorage = createStorageShim();
});

// ---- keyring: addKey / removeKey ----

test("addKey adds exactly one entry to the keyring (owm_keys)", () => {
  api.addKey({ tenant: "Studio-PC", token: "tok-1", name: "Studio" });
  const keys = readKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].tenant, "studio-pc"); // tenant ids normalize to lower case
  assert.equal(keys[0].token, "tok-1");
  assert.equal(keys[0].name, "Studio");
  assert.equal(typeof keys[0].addedAt, "number");
});

test("addKey with the SAME tenant replaces the key instead of duplicating", () => {
  api.addKey({ tenant: "a", token: "tok-1", name: "Old" });
  api.addKey({ tenant: "a", token: "tok-2", name: "New" });
  const keys = readKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].token, "tok-2");
  assert.equal(keys[0].name, "New");
});

test("addKey with a different tenant appends a second entry", () => {
  api.addKey({ tenant: "a", token: "tok-1" });
  api.addKey({ tenant: "b", token: "tok-2" });
  assert.equal(readKeys().length, 2);
});

test("removeKey on the ACTIVE key promotes keys[0] to active", () => {
  api.addKey({ tenant: "a", token: "tok-a", name: "A" });
  api.addKey({ tenant: "b", token: "tok-b", name: "B" });
  api.setToken("tok-a");
  api.setTenant("a", "A");

  assert.equal(api.removeKey("a"), true);
  assert.equal(api.getToken(), "tok-b");
  assert.equal(api.getTenant(), "b");
  const keys = readKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].tenant, "b");
});

test("removeKey on a NON-active key leaves the active machine untouched", () => {
  api.addKey({ tenant: "a", token: "tok-a" });
  api.addKey({ tenant: "b", token: "tok-b" });
  api.setToken("tok-b");
  api.setTenant("b");

  assert.equal(api.removeKey("a"), false);
  assert.equal(api.getToken(), "tok-b");
  assert.equal(api.getTenant(), "b");
  assert.equal(readKeys().length, 1);
});

test("removing the last key clears owm_token/owm_tenant (back to pairing)", () => {
  api.addKey({ tenant: "a", token: "tok-a", name: "A" });
  api.setToken("tok-a");
  api.setTenant("a", "A");

  assert.equal(api.removeKey("a"), true);
  assert.equal(localStorage.getItem("owm_token"), null);
  assert.equal(localStorage.getItem("owm_tenant"), null);
  assert.equal(api.getToken(), "");
  assert.equal(api.getTenant(), "");
  assert.equal(readKeys().length, 0);
});

// ---- migrateKeys (old single token -> owm_keys) ----

test("migrateKeys promotes the legacy single token into the keyring, once", () => {
  localStorage.setItem("owm_token", "legacy-tok");
  localStorage.setItem("owm_tenant", "Legacy-Room");
  localStorage.setItem("owm_tenant_name", "Phòng khách");

  api.migrateKeys();
  let keys = readKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].tenant, "legacy-room"); // normalized to lower case
  assert.equal(keys[0].token, "legacy-tok");
  assert.equal(keys[0].name, "Phòng khách");
  assert.equal(typeof keys[0].addedAt, "number");

  api.migrateKeys(); // a second run must not duplicate
  keys = readKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].token, "legacy-tok");
});

test("migrateKeys keeps an existing owm_keys untouched", () => {
  const existing = [{ tenant: "x", token: "tok-x", name: "X", addedAt: 1 }];
  localStorage.setItem("owm_keys", JSON.stringify(existing));
  localStorage.setItem("owm_token", "other-tok");
  localStorage.setItem("owm_tenant", "other");

  api.migrateKeys();
  assert.equal(localStorage.getItem("owm_keys"), JSON.stringify(existing));
});

test("migrateKeys does nothing without a legacy token", () => {
  api.migrateKeys();
  assert.equal(localStorage.getItem("owm_keys"), null);
});

test("importing api.js touches no storage (migration is lazy, not an IIFE)", async () => {
  const reads = [];
  const recording = createStorageShim();
  const origGet = recording.getItem;
  recording.getItem = (k) => {
    reads.push(k);
    return origGet(k);
  };
  globalThis.localStorage = recording;
  try {
    // Distinct query => a fresh module instance; any import-time localStorage
    // read (a reintroduced IIFE) would land in `reads` and fail this test.
    await import("../src/api.js?probe=import-side-effects");
  } finally {
    globalThis.localStorage = createStorageShim();
  }
  assert.deepEqual(reads, []);
});
