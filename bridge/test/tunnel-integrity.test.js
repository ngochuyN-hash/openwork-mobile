import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyCloudflared, cloudflaredSource } from "../src/tunnel.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("tunnel: hash đúng -> pass, trả về hash tính được", () => {
  const bin = Buffer.from("cloudflared-binary-nguyen-ma");
  const good = sha256(bin);
  assert.equal(verifyCloudflared(bin, good), good);
  // Hoa/thừa khoảng trắng vẫn chấp nhận (hash lấy từ file .txt của chủ nhà có thể có \r)
  assert.equal(verifyCloudflared(bin, good.toUpperCase()), good);
  assert.equal(verifyCloudflared(bin, `  ${good}\n`), good);
});

test("tunnel: hash lệch -> throw, KHÔNG ghi file, nhắc cả 2 hash", () => {
  const bin = Buffer.from("cloudflared-binary-nguyen-ma");
  const expected = sha256(bin);
  const tampered = Buffer.from("cloudflared-binary-nhiem-bon-xau");
  assert.throws(
    () => verifyCloudflared(tampered, expected),
    (error) => {
      assert.match(error.message, /SHA-256 mismatch/);
      assert.ok(error.message.includes(expected), "báo hash mong đợi");
      assert.ok(error.message.includes(sha256(tampered)), "báo hash tính được");
      return true;
    }
  );
});

test("tunnel: expected rỗng/null/không phải 64 hex -> throw, không im lặng bỏ qua", () => {
  const bin = Buffer.from("x");
  for (const bad of ["", "   ", null, undefined, 123, "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    assert.throws(() => verifyCloudflared(bin, bad), /Invalid expected cloudflared SHA-256/, `expected=${String(bad)}`);
  }
});

test("tunnel: URL ghim không phải releases/latest + env override được đọc lúc gọi", () => {
  const saved = { url: process.env.CLOUDFLARED_URL, sha: process.env.CLOUDFLARED_SHA256 };
  try {
    delete process.env.CLOUDFLARED_URL;
    delete process.env.CLOUDFLARED_SHA256;
    const def = cloudflaredSource();
    assert.match(def.url, /releases\/download\/2026\.9\.3\//, "ghim đúng phiên bản");
    assert.doesNotMatch(def.url, /releases\/latest/);
    assert.match(def.sha256, /^[0-9a-f]{64}$/);

    process.env.CLOUDFLARED_URL = "https://example.invalid/cloudflared-windows-amd64.exe";
    process.env.CLOUDFLARED_SHA256 = "A".repeat(64);
    const over = cloudflaredSource();
    assert.equal(over.url, "https://example.invalid/cloudflared-windows-amd64.exe");
    assert.equal(over.sha256, "a".repeat(64), "env override chuẩn hoá lowercase");
  } finally {
    if (saved.url === undefined) delete process.env.CLOUDFLARED_URL;
    else process.env.CLOUDFLARED_URL = saved.url;
    if (saved.sha === undefined) delete process.env.CLOUDFLARED_SHA256;
    else process.env.CLOUDFLARED_SHA256 = saved.sha;
  }
});
// Nhánh PATH của ensureCloudflared từng là chỗ DUY NHẤT chạy cloudflared không
// qua verify hash — một exe giả nằm trong thư mục user-writable trên PATH được
// spawn thay bản ghim. Ghim: file trên PATH cũng phải khớp hash, lệch thì bỏ
// và rơi xuống tải bản ghim (bridge/src/tunnel.js).
test("ensureCloudflared: binary trên PATH phải qua verify hash như bản tải về", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ensureCloudflared } = await import("../src/tunnel.js");

  const dataDir = mkdtempSync(join(tmpdir(), "owm-tun-data-"));
  const binDir = mkdtempSync(join(tmpdir(), "owm-tun-path-"));
  const fake = Buffer.from("fake-cloudflared-bytes-for-path-branch-test");
  const fakeHash = sha256(fake);
  const exeName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const exePath = join(binDir, exeName);
  writeFileSync(exePath, fake);

  const saved = {
    PATH: process.env.PATH,
    dir: process.env.OPENWORK_BRIDGE_DIR,
    url: process.env.CLOUDFLARED_URL,
    sha: process.env.CLOUDFLARED_SHA256,
  };
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.dir === undefined) delete process.env.OPENWORK_BRIDGE_DIR;
    else process.env.OPENWORK_BRIDGE_DIR = saved.dir;
    if (saved.url === undefined) delete process.env.CLOUDFLARED_URL;
    else process.env.CLOUDFLARED_URL = saved.url;
    if (saved.sha === undefined) delete process.env.CLOUDFLARED_SHA256;
    else process.env.CLOUDFLARED_SHA256 = saved.sha;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  process.env.OPENWORK_BRIDGE_DIR = dataDir; // không cache -> phải đi qua nhánh PATH
  process.env.PATH = binDir + (process.platform === "win32" ? ";" : ":") + (saved.PATH ?? "");
  // Nguồn "ghim" của test = hash của file giả; URL tải là loopback cổng hỏng
  // (nếu có lỡ rơi xuống tải thì ném lỗi ngay, KHÔNG ra mạng thật).
  process.env.CLOUDFLARED_URL = "http://127.0.0.1:9/nope";
  process.env.CLOUDFLARED_SHA256 = fakeHash;

  const logs = [];
  const got = await ensureCloudflared((m) => logs.push(String(m)));
  assert.equal(got, exePath, "binary trên PATH khớp hash -> được dùng");

  // Đổi hash ghim lệch: file trên PATH phải bị TỪ CHỐI (không trả về), rồi rơi
  // xuống bước tải từ URL loopback hỏng -> ném lỗi. Nếu hàm trả về file PATH
  // không verify thì assert dưới sẽ thấy resolve thay vì reject.
  process.env.CLOUDFLARED_SHA256 = "0".repeat(64);
  await assert.rejects(() => ensureCloudflared((m) => logs.push(String(m))));
  assert.ok(
    logs.some((m) => m.includes("failed integrity check")),
    "phải log rõ lý do bỏ qua binary trên PATH"
  );
});
