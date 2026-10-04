// Test logic thuần của trạng thái trang Cài đặt (lib/settings-state.js):
// chuẩn hoá danh sách thiết bị + nhãn tunnel + mốc thời gian.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceListOf,
  formatDeviceTime,
  openworkInfoChanged,
  tunnelStatusLabel,
  tryCopyText,
} from "../src/lib/settings-state.js";

// ---- deviceListOf ----

test("deviceListOf đọc được cả mảng và {devices}", () => {
  const one = [{ id: "d1", label: "iPhone" }];
  assert.deepEqual(deviceListOf(one), one);
  assert.deepEqual(deviceListOf({ devices: one }), one);
});

test("deviceListOf LUÔN trả mảng — payload rác không làm vỡ render (bug sập trắng)", () => {
  // Bản cũ: `const { devices } = await apiRevokeDevice(...)` rồi setDevices(devices).
  // Response thiếu `devices` -> undefined -> `devices.length` ném TypeError ->
  // sập trắng toàn bộ màn Cài đặt ngay sau một cú bấm Thu hồi.
  for (const bad of [undefined, null, {}, { devices: null }, { devices: "x" }, "x", 42, [null]]) {
    assert.ok(Array.isArray(deviceListOf(bad)), `shape ${JSON.stringify(bad)} phải ra mảng`);
  }
});

// ---- tunnelStatusLabel ----

test("tunnelStatusLabel đọc đúng phase của bridge (up/starting/backoff)", () => {
  // bridge/src/tunnel.js:114 — getState() trả {phase, url, streak, nextRetryAt}
  assert.deepEqual(tunnelStatusLabel({ phase: "up", url: "https://x.trycloudflare.com" }), {
    label: "running",
    ok: true,
  });
  assert.equal(tunnelStatusLabel({ phase: "starting" }).label, "starting");
  assert.equal(tunnelStatusLabel({ phase: "up" }).ok, true);
  assert.equal(tunnelStatusLabel({ phase: "starting" }).ok, false);
});

test("backoff nói rõ đã bị giới hạn bao nhiêu lần", () => {
  const r = tunnelStatusLabel({ phase: "backoff", streak: 4 });
  assert.equal(r.ok, false);
  assert.match(r.label, /4/);
  assert.match(r.label, /rate-limited/);
});

test("thiếu/sai shape tunnel -> 'không rõ', KHÔNG đoán là chết", () => {
  for (const t of [null, undefined, {}, { phase: "" }, { phase: "wat" }, "x"]) {
    assert.equal(tunnelStatusLabel(t).label, "unknown");
  }
});

// ---- formatDeviceTime ----

test("formatDeviceTime trả '—' thay vì 'Invalid Date'", () => {
  assert.equal(formatDeviceTime(undefined), "—");
  assert.equal(formatDeviceTime(null), "—");
  assert.equal(formatDeviceTime(""), "—");
  assert.equal(formatDeviceTime("không-phải-ngày"), "—");
});

test("formatDeviceTime đọc được mốc hợp lệ", () => {
  const s = formatDeviceTime(1700000000000);
  assert.equal(/Invalid/.test(s), false);
  assert.ok(s.length > 0);
  assert.equal(formatDeviceTime(new Date(1700000000000)), s);
});

// ---- openworkInfoChanged ----

test("openworkInfoChanged: cùng nội dung dù khác đồng nhất -> KHÔNG đổi", () => {
  // app poll /api/state mỗi 15s, mỗi lần JSON.parse sinh object MỚI. So đồng
  // nhất tham chiếu sẽ báo "đổi" mỗi 15s và xoá override ngay sau khi bấm
  // "Chỉ đường dẫn" -> màn Cài đặt quay về "chưa thấy exe".
  const a = { found: true, running: false, exe: "C:/a/OpenWork.exe", version: "0.18.54", candidates: ["x"] };
  const b = { found: true, running: false, exe: "C:/a/OpenWork.exe", version: "0.18.54", candidates: ["x"] };
  assert.notEqual(a, b, "precondition: hai object khác đồng nhất");
  assert.equal(openworkInfoChanged(a, b), false);
});

test("openworkInfoChanged: khác ở field nào cũng bắt được", () => {
  const base = { found: true, running: false, exe: "e", version: "1", source: "config", candidates: [] };
  for (const patch of [
    { found: false },
    { running: true },
    { exe: "f" },
    { version: "2" },
    { source: "env" },
  ]) {
    assert.equal(openworkInfoChanged(base, { ...base, ...patch }), true, JSON.stringify(patch));
  }
  assert.equal(openworkInfoChanged(base, { ...base, candidates: ["a"] }), true);
});

test("openworkInfoChanged: candidates rỗng và thiếu là một", () => {
  const base = { found: true };
  assert.equal(openworkInfoChanged(base, { found: true, candidates: [] }), false);
  assert.equal(openworkInfoChanged(base, { found: true, candidates: ["a"] }), true);
});

test("openworkInfoChanged: null sang null thì không đổi, null sang object thì đổi", () => {
  assert.equal(openworkInfoChanged(null, null), false);
  assert.equal(openworkInfoChanged(undefined, null), false);
  assert.equal(openworkInfoChanged(null, { found: true }), true);
  assert.equal(openworkInfoChanged({ found: true }, null), true);
});

// ---- tryCopyText ----

test("tryCopyText: clipboard undefined -> false, KHÔNG báo thành công", async () => {
  // Bug cũ: `await navigator?.clipboard?.writeText(t)` với clipboard undefined
  // resolve ngay (await undefined) -> app báo "Đã chép" dù chưa chép gì.
  assert.equal(await tryCopyText(undefined, "C:/a/OpenWork.exe"), false);
  assert.equal(await tryCopyText(null, "x"), false);
  assert.equal(await tryCopyText({}, "x"), false); // không có writeText
});

test("tryCopyText: chép thật thì true và ghi đúng nội dung", async () => {
  let wrote = null;
  const clip = { writeText: async (t) => { wrote = t; } };
  assert.equal(await tryCopyText(clip, "C:/a/OpenWork.exe"), true);
  assert.equal(wrote, "C:/a/OpenWork.exe");
});

test("tryCopyText: writeText ném -> false (không crash)", async () => {
  const clip = { writeText: async () => { throw new Error("NotAllowedError"); } };
  assert.equal(await tryCopyText(clip, "x"), false);
});

test("tryCopyText: chuỗi rỗng thì không gọi clipboard, trả false", async () => {
  let called = false;
  const clip = { writeText: async () => { called = true; } };
  assert.equal(await tryCopyText(clip, ""), false);
  assert.equal(await tryCopyText(clip, null), false);
  assert.equal(called, false);
});
