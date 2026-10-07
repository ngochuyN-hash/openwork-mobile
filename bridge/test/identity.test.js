// applyIdentity — deep module "machine identity" (candidate 1+2, review 07/10).
// Hai route (/api/machine/name, /api/config/identity) chỉ là adapter mỏng gọi
// nó; test HÀNH VI qua HTTP vẫn nằm ở routes.test.js + config-routes.test.js
// (giờ chúng test đúng phần adapter + auth). File này pin LUẬT ở một chỗ:
//   1. whitelist đọc từ shared/identity-keys.txt — ĐÚNG 4 key, cùng nguồn với
//      IdentityKeys.cs mà build.bat sinh cho GUI C#;
//   2. sanitize machineName (bóc [\r\n"'], trim, trần 60) — luật cũ của cả 2
//      route trước khi gộp;
//   3. key còn lại trim + trần 300;
//   4. ghi config.json NGAY khi có key áp; không key nào hợp lệ thì KHÔNG ghi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyIdentity, loadIdentityKeys, sanitizeMachineName } from "../src/identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED_KEYS = ["lookupUrl", "lookupTenant", "lookupSecret", "machineName"];

test("whitelist đọc từ shared/identity-keys.txt — pin ĐÚNG 4 key (nguồn chung với GUI C#)", () => {
  assert.deepEqual(loadIdentityKeys(), EXPECTED_KEYS);
  // File trên đĩa không được chứa gì ngoài comment + đúng 4 key trên.
  const raw = readFileSync(join(ROOT, "shared", "identity-keys.txt"), "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(lines, EXPECTED_KEYS);
});

test("sanitizeMachineName: bóc CR/LF/nháy, trim, trần 60 — luật cũ của cả 2 route", () => {
  assert.equal(sanitizeMachineName('bad"\r\nname' + "x".repeat(80)), "badname" + "x".repeat(53));
  assert.ok(sanitizeMachineName('bad"\r\nname' + "x".repeat(80)).length <= 60);
  assert.equal(sanitizeMachineName('  Máy "chính"\r\n'), "Máy chính");
  assert.equal(sanitizeMachineName("   "), "");
  assert.equal(sanitizeMachineName(undefined), "");
  assert.equal(sanitizeMachineName(null), "");
});

/** Mỗi test một OPENWORK_BRIDGE_DIR tạm: saveConfig ghi config.json vào
 * bridgeDataDir() theo env LÚC GỌI — không cô lập là ghi vào store thật. */
async function withTempBridgeDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "owm-identity-"));
  const prev = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (prev === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("applyIdentity: chỉ nhận key whitelist + string, ghi config.json đúng giá trị sạch", async () => {
  await withTempBridgeDir((dir) => {
    const config = { mobileToken: "owm_keep", port: 8788, lookupTenant: "", machineName: "" };
    const applied = applyIdentity(config, {
      lookupTenant: "  pc-room01  ",
      machineName: 'bad"\r\nname',
      lookupSecret: "ows_secret1",
      mobileToken: "owm_hijack", // ngoài whitelist — phải bị bỏ qua
      port: 9999, // không phải string — phải bị bỏ qua
    });
    assert.deepEqual(applied.sort(), ["lookupSecret", "lookupTenant", "machineName"]);
    assert.equal(config.lookupTenant, "pc-room01");
    assert.equal(config.machineName, "badname");
    assert.equal(config.lookupSecret, "ows_secret1");
    assert.equal(config.mobileToken, "owm_keep", "mobileToken không được đụng");
    assert.equal(config.port, 8788, "port không được đụng");

    const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(stored.lookupTenant, "pc-room01");
    assert.equal(stored.machineName, "badname");
    assert.equal(stored.mobileToken, "owm_keep");
  });
});

test("applyIdentity: không key nào hợp lệ → KHÔNG ghi config.json", async () => {
  await withTempBridgeDir((dir) => {
    const config = { machineName: "giu-nguyen" };
    assert.deepEqual(applyIdentity(config, { mobileToken: "x", port: 1, lookupUrl: 42 }), []);
    assert.equal(config.machineName, "giu-nguyen");
    assert.equal(existsSync(join(dir, "config.json")), false, "không được ghi file khi không áp key nào");
  });
});
