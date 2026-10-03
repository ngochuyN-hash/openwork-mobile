import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

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
