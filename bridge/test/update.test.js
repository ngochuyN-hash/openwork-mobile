import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  shouldUpdateNow,
  sha256Hex,
  extractPayload,
  installRelease,
  restoreBackup,
  MIN_UPTIME_MS,
} from "../src/update.js";

test("compareVersions: số theo từng phần dấu chấm", () => {
  assert.equal(compareVersions("2026.09.15.1", "2026.09.15.2"), -1);
  assert.equal(compareVersions("2026.09.16.0", "2026.09.15.99"), 1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("2026.09.15.1", "2025.12.31.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0); // phần thiếu = 0
});

test("shouldUpdateNow: đủ mọi cửa an toàn mới cho cập nhật", () => {
  const base = {
    remote: { version: "2026.09.16.0" },
    current: "2026.09.15.1",
    tunnel: { phase: "up", url: "https://x.trycloudflare.com" },
    viewerCount: 0,
    uptimeMs: 10 * 60 * 1000,
  };
  assert.deepEqual(shouldUpdateNow(base), { ok: true });

  // Không có bản mới hơn
  assert.equal(shouldUpdateNow({ ...base, remote: { version: "0.1.0" } }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, current: "2026.09.16.0" }).ok, false);

  // Tunnel chưa lên / đang backoff
  assert.equal(shouldUpdateNow({ ...base, tunnel: { phase: "starting", url: "" } }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, tunnel: { phase: "backoff", url: "" } }).ok, false);

  // Có người đang xem màn hình — không được đá giữa chừng
  assert.equal(shouldUpdateNow({ ...base, viewerCount: 1 }).ok, false);

  // Bridge vừa dậy chưa đủ 5 phút — không restart sớm (tránh 429)
  assert.equal(shouldUpdateNow({ ...base, uptimeMs: 1000 }).ok, false);
  assert.equal(shouldUpdateNow({ ...base, uptimeMs: MIN_UPTIME_MS }).ok, true);
});

test("sha256Hex: đúng chuẩn đối chiếu payload", () => {
  assert.equal(
    sha256Hex(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  // Cùng payload → cùng hash (stable — điều worker manifest dựa vào)
  assert.equal(sha256Hex(Buffer.from("x")), sha256Hex(Buffer.from("x")));
});

test("extractPayload: giải nén đúng cấu trúc + chặn path traversal", () => {
  const stage = mkdtempSync(join(tmpdir(), "ota-stage-"));
  try {
    const payload = {
      files: {
        "src/index.js": Buffer.from("console.log(1)").toString("base64"),
        "package.json": Buffer.from("{}").toString("base64"),
      },
    };
    assert.equal(extractPayload(payload, stage), 2);
    assert.equal(readFileSync(join(stage, "src", "index.js"), "utf8"), "console.log(1)");

    // Path traversal ra ngoài stage bị từ chối
    assert.throws(() => extractPayload({ files: { "../escape.js": "aGk=" } }, stage));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

/** Dựng cây giả lập repo bridge trong temp: src/index.js + scripts/ + VERSION. */
function fakeBridgeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ota-root-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.js"), 'console.log("old")');
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "ota-watchdog.mjs"), 'console.log("wd-old")');
  writeFileSync(join(root, "VERSION"), "2026.09.15.1");
  return root;
}

test("installRelease: swap atomic src→backup, cài bản mới, arm state", () => {
  const root = fakeBridgeRoot();
  try {
    const payload = {
      version: "2026.09.16.0",
      files: {
        "src/index.js": Buffer.from('console.log("new")').toString("base64"),
        "scripts/ota-watchdog.mjs": Buffer.from('console.log("wd")').toString("base64"),
        "VERSION": Buffer.from("2026.09.16.0").toString("base64"),
      },
    };
    const to = installRelease(payload, { bridgeRoot: root, from: "2026.09.15.1" });
    assert.equal(to, "2026.09.16.0");
    // src giờ là bản mới, backup giữ bản cũ (rename cả thư mục src → .ota-backup)
    assert.equal(readFileSync(join(root, "src", "index.js"), "utf8"), 'console.log("new")');
    assert.equal(readFileSync(join(root, ".ota-backup", "index.js"), "utf8"), 'console.log("old")');
    // watchdog ngoài src/ cũng được thăng cấp — cài mới / OTA thiếu nó là mất rollback
    assert.equal(readFileSync(join(root, "scripts", "ota-watchdog.mjs"), "utf8"), 'console.log("wd")');
    assert.equal(readFileSync(join(root, "VERSION"), "utf8"), "2026.09.16.0");
    assert.equal(JSON.parse(readFileSync(join(root, ".ota", "state.json"), "utf8")).phase, "applying");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installRelease: từ chối khi đang có update chưa xác nhận", () => {
  const root = fakeBridgeRoot();
  try {
    const payload = {
      version: "2026.09.17.0",
      files: { "src/index.js": Buffer.from('x').toString("base64") },
    };
    installRelease(payload, { bridgeRoot: root });
    // Lần hai — state vẫn "applying" vì không ai markBootOk
    assert.throws(() => installRelease(payload, { bridgeRoot: root }), /đang có update/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreBackup: bản mới vỡ → trả về bản cũ", () => {
  const root = fakeBridgeRoot();
  try {
    installRelease(
      { version: "2026.09.16.0", files: { "src/index.js": Buffer.from('console.log("new")').toString("base64") } },
      { bridgeRoot: root }
    );
    assert.equal(restoreBackup(root), true);
    assert.equal(readFileSync(join(root, "src", "index.js"), "utf8"), 'console.log("old")');
    assert.equal(existsSync(join(root, ".ota-backup")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});