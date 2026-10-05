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