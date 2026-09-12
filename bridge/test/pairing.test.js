import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingService } from "../src/pairing.js";

function freshService({ now = 1_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owm-pair-"));
  process.env.OPENWORK_BRIDGE_DIR = dir;
  const clock = { value: now };
  const service = new PairingService({ now: () => clock.value });
  return { service, clock, dir, restore: () => rmSync(dir, { recursive: true, force: true }) };
}

test("mã one-time: dùng đúng 1 lần, lần 2 bị từ chối", () => {
  const { service, restore } = freshService();
  try {
    const code = service.ensureCode();
    const first = service.pair(code, "iPhone");
    assert.ok(first?.token?.startsWith("owd_"));
    assert.equal(first.device.label, "iPhone");
    const second = service.pair(code, "Clone");
    assert.equal(second, null);
    // mã mới đã được cấp cho lượt ghép tiếp theo
    const newCode = service.ensureCode();
    assert.notEqual(newCode, code);
    assert.ok(service.pair(newCode, "iPad"));
  } finally {
    restore();
  }
});

test("mã sai / hết hạn bị từ chối", () => {
  const { service, clock, restore } = freshService();
  try {
    assert.equal(service.pair("WRONGCODE", "X"), null);
    const code = service.ensureCode();
    clock.value += 31 * 60 * 1000; // +31 phút
    assert.equal(service.pair(code, "Trễ"), null);
  } finally {
    restore();
  }
});

test("khóa thiết bị: xác thực được và thu hồi là chết", () => {
  const { service, restore } = freshService();
  try {
    const { token, device } = service.pair(service.ensureCode(), "iPhone");
    const found = service.authenticate(token);
    assert.equal(found.id, device.id);
    assert.ok(!("tokenHash" in found)); // không lộ hash ra ngoài

    assert.ok(service.revoke(device.id));
    assert.equal(service.authenticate(token), null);
    assert.equal(service.revoke(device.id), false);
  } finally {
    restore();
  }
});

test("token rác không xác thực được; thiết bị persist qua instance mới", () => {
  const { service, dir, restore } = freshService();
  try {
    const { token, device } = service.pair(service.ensureCode(), "iPad");
    assert.equal(service.authenticate("owd_khongco"), null);

    // instance mới đọc lại devices.json từ đĩa
    const reloaded = new PairingService();
    assert.equal(reloaded.authenticate(token)?.id, device.id);
    assert.equal(reloaded.list().length, 1);
    void dir;
  } finally {
    restore();
  }
});

test("mintDevice: cấp khóa vĩnh viễn không cần mã (dùng cho đăng nhập phòng)", () => {
  const { service, restore } = freshService();
  try {
    const { token, device } = service.mintDevice("Web của Nam");
    assert.ok(token.startsWith("owd_"));
    assert.equal(device.label, "Web của Nam");
    assert.equal(service.authenticate(token)?.id, device.id);

    // không tên -> nhãn mặc định theo thời gian, vẫn dùng được
    const anon = service.mintDevice("");
    assert.ok(anon.device.label.length > 0);
    assert.ok(service.authenticate(anon.token));

    // khóa của mintDevice KHÔNG tiêu tốn mã one-time (mã cũ vẫn còn giá trị)
    const code = service.ensureCode();
    assert.ok(service.pair(code, "iPhone"));
  } finally {
    restore();
  }
});
