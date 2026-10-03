import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, pairingBaseUrl } from "../src/config.js";

// loadConfig reads OPENWORK_BRIDGE_DIR — point it at a temp dir per test and
// restore the previous value afterwards.
function withConfigDir(configJson, fn) {
  const dir = mkdtempSync(join(tmpdir(), "owm-config-"));
  const prev = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  try {
    if (configJson !== null) writeFileSync(join(dir, "config.json"), JSON.stringify(configJson));
    return fn();
  } finally {
    if (prev === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: giá trị rác trong config.json không được đè lên validated defaults", () => {
  withConfigDir(
    { port: "8080", mobileToken: null, lastServerPort: "x", lookupTenant: 42, futureUnknownKey: "keep-me" },
    () => {
      const config = loadConfig();
      // port "8080" (string) once passed straight through: server.listen("8080")
      // on Windows binds a NAMED PIPE, not a port — the validated integer wins now.
      assert.equal(config.port, 8788);
      assert.equal(Number.isInteger(config.port), true);
      assert.equal(typeof config.mobileToken, "string");
      assert.ok(config.mobileToken.startsWith("owm_"), "null token must be regenerated");
      assert.equal(config.lastServerPort, 0);
      assert.equal(config.lookupTenant, "");
      // Unknown/forward-compat keys still pass through untouched.
      assert.equal(config.futureUnknownKey, "keep-me");
    }
  );
});

test("config: giá trị hợp lệ trong config.json vẫn thắng như cũ", () => {
  withConfigDir(
    { port: 9123, mobileToken: "owm_valid_token", lookupTenant: "myroom", autoLaunchOpenWork: true, ownerToken: "owt_owner" },
    () => {
      const config = loadConfig();
      assert.equal(config.port, 9123);
      assert.equal(config.mobileToken, "owm_valid_token");
      assert.equal(config.lookupTenant, "myroom");
      assert.equal(config.autoLaunchOpenWork, true);
      assert.equal(config.ownerToken, "owt_owner");
    }
  );
});

// The pairing QR base must never point at the worker when the machine has no
// room: the worker refuses roomless web entries (400 tenant_required), so the
// printed QR would advertise a dead link. Fallback order: tunnel → publicUrl
// → localhost.
test("config: pairingBaseUrl — the worker base only wins WITH a room, roomless falls back to tunnel/public", () => {
  // Room joined: the fixed worker address wins, tunnel/public ignored.
  assert.equal(pairingBaseUrl({ lookupUrl: "https://w.example/", lookupTenant: "pc-1" }, "https://tunnel.example", "https://pub.example"), "https://w.example");
  // Same config WITHOUT a room: the worker address must NOT be used.
  assert.equal(pairingBaseUrl({ lookupUrl: "https://w.example", lookupTenant: "" }, "https://tunnel.example", "https://pub.example"), "https://tunnel.example");
  // lookupUrl missing entirely → tunnel still wins over publicUrl.
  assert.equal(pairingBaseUrl({ lookupUrl: "", lookupTenant: "pc-1" }, "https://tunnel.example", "https://pub.example"), "https://tunnel.example");
  // No tunnel up yet → publicUrl, then localhost with the bridge port.
  assert.equal(pairingBaseUrl({ lookupUrl: "https://w.example", lookupTenant: "" }, "", "https://pub.example"), "https://pub.example");
  assert.equal(pairingBaseUrl({ lookupUrl: "https://w.example", lookupTenant: "" }, "", "", 8899), "http://127.0.0.1:8899");
  // Whitespace/empty-string lookupTenant counts as no room.
  assert.equal(pairingBaseUrl({ lookupUrl: "https://w.example", lookupTenant: "  " }, "https://tunnel.example"), "https://tunnel.example");
});
