// pairing-state.json — nguồn số 2 của `openpocket code` lúc bridge chết.
// Ghim 3 điều: roundtrip giữ đúng shape, thiếu/hỏng trả null (không ném), và
// CLI đi qua seam này (hết parse lời log "Mã ghép:" + hết literal route tay —
// literal đó từng lọt ngoài mọi drift-guard của web/bridge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

// House rule: tests never touch a real bridge / openwork data directory.
process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(`${tmpdir()}/owm-bridge-test-`);
process.env.OPENWORK_DIR = mkdtempSync(`${tmpdir()}/owm-data-test-`);

const { savePairingState, loadPairingState } = await import("../src/pairing-state.js");
const { PairingService } = await import("../src/pairing.js");

test("chưa ghi -> null; save -> load roundtrip giữ code/expiresAt/baseUrl", () => {
  // Chạy TRƯỚC mọi test ghi: temp dir của file test là mới, file chưa tồn tại.
  assert.equal(loadPairingState(), null);
  savePairingState({ code: "ABCD2345", expiresAt: 1234567890, baseUrl: "https://worker.example" });
  const snap = loadPairingState();
  assert.equal(snap.code, "ABCD2345");
  assert.equal(snap.expiresAt, 1234567890);
  assert.equal(snap.baseUrl, "https://worker.example");
  assert.ok(typeof snap.updatedAt === "number");
});

test("PairingService sinh mã mới là state file phải theo kịp (onCode -> savePairingState)", () => {
  let now = 1_000_000;
  const svc = new PairingService({ now: () => now });
  svc.onCode = (code, expiresAt) => savePairingState({ code, expiresAt, baseUrl: "https://w.example" });
  const first = svc.ensureCode();
  assert.equal(loadPairingState().code, first);
  // Hết hạn -> sinh mã MỚI: ảnh chụp phải là mã mới, không phải mã cũ.
  now += 31 * 60_000;
  const second = svc.ensureCode();
  assert.notEqual(second, first);
  assert.equal(loadPairingState().code, second);
});

test("CLI đi qua seam: hết parse log, hết literal route tay", () => {
  const src = readFileSync(new URL("../bin/openpocket.js", import.meta.url), "utf8");
  assert.ok(src.includes("BRIDGE_ROUTES.pairingCode"), "route ghép phải qua contract");
  assert.ok(!src.includes('"/api/pairing-code"'), "literal route tay là literal cuối còn sót ngoài drift-guard");
  // Ghim đúng MÁY MÓC parse (không phải chuỗi hiển thị): hết split lời log,
  // hết quét URL trong log, hết đọc bridge.log làm nguồn số 2.
  assert.ok(!src.includes("matchAll"), "hết quét URL trong log");
  assert.ok(!src.includes("split(/"), "hết split lời log");
  assert.ok(!src.includes("readFileSync(logFile()"), "log không còn là machine interface");
  assert.ok(src.includes("loadPairingState"), "fallback đọc pairing-state.json");
});
