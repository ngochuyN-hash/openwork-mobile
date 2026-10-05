import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, hardenConfigFile } from "../src/config.js";

// config.json giữ token plaintext (chủ nhà chốt giữ vì GUI C# đọc thẳng),
// nên phòng vệ là: (1) siết quyền file sau mỗi lần ghi, (2) load lại được
// nguyên vẹn. Mọi test ở đây trỏ OPENWORK_BRIDGE_DIR vào thư mục tạm —
// không bao giờ chạm %APPDATA%/openwork-bridge thật.
const isWindows = process.platform === "win32";

function withConfigDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "owm-secrets-"));
  const prev = process.env.OPENWORK_BRIDGE_DIR;
  process.env.OPENWORK_BRIDGE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Token GIẢ trong test — không bao giờ dùng giá trị thật.
const FAKE = {
  mobileToken: "owm_test_fake_mobile_token_0000000000",
  ownerToken: "owt_test_fake_owner_token",
  lookupSecret: "ows_test_fake_lookup_secret",
  lookupTenant: "pc-test",
  port: 8788,
};

test("config: saveConfig siet quyen config.json — khong nem, file van co", () => {
  withConfigDir((dir) => {
    const file = saveConfig({ ...FAKE });
    assert.equal(file, join(dir, "config.json"));
    // Ghi + siết quyền phải xong mà không ném lỗi lên caller (hardening
    // là best-effort: ACL hỏng cũng không được làm bridge chết).
    assert.equal(existsSync(file), true);
    assert.ok(statSync(file).size > 0, "config.json phai co noi dung");

    if (isWindows) {
      // Nhánh icacls: bất đồng bộ + fire-and-forget nên chỉ assert được
      // "không ném" ở đây. Quyền thật kiểm bằng test chmod bên dưới.
      return;
    }
    // Nhánh POSIX: 600 = chỉ owner đọc/ghi.
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("config: loadConfig doc lai dung config vua ghi (token gia)", () => {
  withConfigDir(() => {
    saveConfig({ ...FAKE, publicUrl: "https://pub.example", machineName: "test-machine" });
    const config = loadConfig();
    assert.equal(config.mobileToken, FAKE.mobileToken);
    assert.equal(config.ownerToken, FAKE.ownerToken);
    assert.equal(config.lookupSecret, FAKE.lookupSecret);
    assert.equal(config.lookupTenant, FAKE.lookupTenant);
    assert.equal(config.port, FAKE.port);
    assert.equal(config.publicUrl, "https://pub.example");
    assert.equal(config.machineName, "test-machine");
  });
});

test("config: hardenConfigFile khong nem khi that bai (hardening la best-effort)", () => {
  withConfigDir((dir) => {
    // Đường dẫn không tồn tại: phải nuốt lỗi, không ném lên caller — nếu
    // ném, một lần ACL hỏng sẽ làm cả bridge sập.
    assert.doesNotThrow(() => hardenConfigFile(join(dir, "khong-ton-tai.json")));
    // Ghi lại nhiều lần vẫn phải đọc được giá trị mới nhất.
    assert.doesNotThrow(() => {
      saveConfig({ ...FAKE, port: 9999 });
      saveConfig({ ...FAKE, port: 9999 });
    });
    assert.equal(loadConfig().port, 9999);
  });
});