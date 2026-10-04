// Test lib thuần đếm ngược mã ghép (web/src/lib/pairing-code.js).
// Không đụng bridge / dữ liệu thật — hàm nhận thời gian vào qua tham số.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPairingCountdown, pairingDeadline, pairingSecondsLeft } from "../src/lib/pairing-code.js";

test("formatPairingCountdown: mm:ss hai chữ", () => {
  assert.equal(formatPairingCountdown(0), "00:00");
  assert.equal(formatPairingCountdown(5), "00:05");
  assert.equal(formatPairingCountdown(90), "01:30");
  // 30 phút — trần TTL của bridge
  assert.equal(formatPairingCountdown(30 * 60), "30:00");
  assert.equal(formatPairingCountdown(30 * 60 - 1), "29:59");
});

test("formatPairingCountdown: rác/âm/float kẹp về mức không âm", () => {
  assert.equal(formatPairingCountdown(-3), "00:00");
  assert.equal(formatPairingCountdown(NaN), "00:00");
  assert.equal(formatPairingCountdown(undefined), "00:00");
  assert.equal(formatPairingCountdown(59.9), "00:59"); // floor, không round
});

test("pairingDeadline + pairingSecondsLeft: vòng tròn khớp lại đúng giây", () => {
  const now = 1_700_000_000_000;
  const deadline = pairingDeadline(1800, now);
  assert.equal(deadline - now, 1_800_000);
  assert.equal(pairingSecondsLeft(deadline, now + 30_000), 1770);
  assert.equal(pairingSecondsLeft(deadline, now), 1800);
});

test("pairingSecondsLeft: đã qua mốc trả 0, không âm", () => {
  const now = 1_700_000_000_000;
  const deadline = pairingDeadline(60, now);
  assert.equal(pairingSecondsLeft(deadline, now + 61_000), 0);
  assert.equal(pairingSecondsLeft(deadline, now + 10 * 60_000), 0);
  // mốc rác (0/NaN) coi như đã hết hạn
  assert.equal(pairingSecondsLeft(0, now), 0);
  assert.equal(pairingSecondsLeft(NaN, now), 0);
});

test("pairingSecondsLeft dùng floor như bridge — không lệch 1 giây", () => {
  const now = 1_700_000_000_000;
  const deadline = pairingDeadline(1800, now);
  // Còn 1799.6s: floor -> 1799 (khớp bridge), round -> 1800 (lệch, hiện
  // "còn 30:00" khi bridge đã tính 29:59).
  assert.equal(pairingSecondsLeft(deadline, now + 400), 1799);
  assert.equal(formatPairingCountdown(pairingSecondsLeft(deadline, now + 400)), "29:59");
  // Còn 0.4s: floor -> 0, không bao giờ hiện "còn 1s" khi bridge đã hết hạn.
  assert.equal(pairingSecondsLeft(deadline, deadline - 400), 0);
});
