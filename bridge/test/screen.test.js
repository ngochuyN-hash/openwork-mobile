import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeFrame,
  normalizeInput,
  createRateLimiter,
  FRAME_UNCHANGED,
  FRAME_JPEG,
  FRAME_META,
} from "../src/screen.js";

test("encodeFrame: [4B độ dài][1B type][payload] khớp vòng lặp parse", () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const frame = encodeFrame(FRAME_JPEG, payload);
  assert.equal(frame.length, 5 + payload.length);
  assert.equal(frame.readUInt32BE(0), 5);
  assert.equal(frame.readUInt8(4), FRAME_JPEG);
  assert.deepEqual([...frame.subarray(5)], [1, 2, 3, 4, 5]);

  // Frame rỗng (màn đứng yên) chỉ có header
  const empty = encodeFrame(FRAME_UNCHANGED);
  assert.equal(empty.length, 5);
  assert.equal(empty.readUInt32BE(0), 0);
  assert.equal(empty.readUInt8(4), FRAME_UNCHANGED);
});

test("normalizeInput: tọa độ 0..1 -> pixel theo kích thước màn thật", () => {
  const dims = { width: 2880, height: 1800 };
  assert.equal(normalizeInput({ type: "click", x: 0.5, y: 0.5 }, dims), "CLICK|1440|900|1|0");
  assert.equal(normalizeInput({ type: "rclick", x: 0, y: 0 }, dims), "CLICK|0|0|2|0");
  assert.equal(normalizeInput({ type: "dbl", x: 1, y: 1 }, dims), "CLICK|2879|1799|1|1");
  assert.equal(normalizeInput({ type: "move", x: 0.25, y: 0.75 }, dims), "MOVE|720|1349");
  assert.equal(normalizeInput({ type: "down", x: 0.1, y: 0.2, button: 2 }, dims), "DOWN|288|360|2");
  assert.equal(normalizeInput({ type: "up", x: 0.1, y: 0.2 }, dims), "UP|288|360|1");
});

test("normalizeInput: wheel clamp ±10 notch, key/combo/text hợp lệ", () => {
  assert.equal(normalizeInput({ type: "wheel", dy: 3 }, { width: 100, height: 100 }), "WHEEL|0|3");
  assert.equal(normalizeInput({ type: "wheel", dy: 999 }, { width: 100, height: 100 }), "WHEEL|0|10");
  assert.equal(normalizeInput({ type: "wheel", dx: -50, dy: -1 }, { width: 100, height: 100 }), "WHEEL|-10|-1");
  assert.equal(normalizeInput({ type: "key", key: "enter" }, { width: 100, height: 100 }), "KEY|enter");
  assert.equal(normalizeInput({ type: "key", key: "a" }, { width: 100, height: 100 }), "KEY|A");
  assert.equal(
    normalizeInput({ type: "combo", mods: ["ctrl", "shift"], key: "esc" }, { width: 100, height: 100 }),
    "COMBO|ctrl,shift|esc"
  );
  const textLine = normalizeInput({ type: "text", text: "Xin chào" }, { width: 100, height: 100 });
  assert.equal(textLine, `TEXT|${Buffer.from("Xin chào", "utf8").toString("base64")}`);
});

test("normalizeInput: chặn đầu vào xấu", () => {
  const dims = { width: 100, height: 100 };
  assert.throws(() => normalizeInput({ type: "click", x: 5, y: 0.5 }, dims)); // x ngoài 0..1
  assert.throws(() => normalizeInput({ type: "click", x: "abc", y: 0.5 }, dims));
  assert.throws(() => normalizeInput({ type: "key", key: "winkey" }, dims)); // tên không có trong bảng
  assert.throws(() => normalizeInput({ type: "combo", mods: [], key: "a" }, dims)); // thiếu mods
  assert.throws(() => normalizeInput({ type: "combo", mods: ["super"], key: "a" }, dims)); // mod lạ
  assert.throws(() => normalizeInput({ type: "text", text: "" }, dims)); // rỗng
  assert.throws(() => normalizeInput({ type: "text", text: "x".repeat(501) }, dims)); // quá dài
  assert.throws(() => normalizeInput({ type: "lệnh_lạ" }, dims));
  assert.throws(() => normalizeInput({ type: "click", x: 0.5, y: 0.5 }, null)); // chưa biết dims
});

test("createRateLimiter: chặn vượt max trong cửa sổ, nhả lại sau khi qua cửa", async () => {
  const limited = createRateLimiter(3, 50);
  assert.equal(limited("1.2.3.4"), false);
  assert.equal(limited("1.2.3.4"), false);
  assert.equal(limited("1.2.3.4"), false);
  assert.equal(limited("1.2.3.4"), true); // lần 4 trong cửa sổ -> chặn
  assert.equal(limited("5.6.7.8"), false); // IP khác không ảnh hưởng
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(limited("1.2.3.4"), false); // hết cửa sổ -> cho lại
});

test("encodeFrame + parse lại: meta JSON đi trọn vẹn", () => {
  const meta = Buffer.from(JSON.stringify({ screenW: 2880, screenH: 1800 }));
  const frame = encodeFrame(FRAME_META, meta);
  const len = frame.readUInt32BE(0);
  assert.equal(frame.readUInt8(4), FRAME_META);
  assert.equal(JSON.parse(frame.subarray(5, 5 + len).toString("utf8")).screenW, 2880);
});
