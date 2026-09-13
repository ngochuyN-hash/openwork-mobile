import { test } from "node:test";
import assert from "node:assert/strict";
import { isFullFrameShot } from "../src/lib/fullframe.js";

test("isFullFrameShot: dải ngang (0,0) rộng-thấp KHÔNG phải full frame", () => {
  // Đầy bề ngang nhưng chỉ cao ~22% — lỗi 14/09 từng lọt vì gate cũ so diện
  // tích với canvas mặc định 300×150 (ngưỡng chỉ 40.500px).
  assert.equal(isFullFrameShot(0, 0, 880, 120, 880, 551), false);
  assert.equal(isFullFrameShot(0, 0, 836, 500, 880, 551), false); // w chớm dưới 95%
  assert.equal(isFullFrameShot(0, 0, 880, 523, 880, 551), false); // h chớm dưới 95%
});

test("isFullFrameShot: khung full thật được nhận, crop khác gốc bị loại", () => {
  assert.equal(isFullFrameShot(0, 0, 880, 551, 880, 551), true);
  assert.equal(isFullFrameShot(0, 0, 840, 525, 880, 551), true); // ≥95% cả hai chiều
  assert.equal(isFullFrameShot(10, 0, 880, 551, 880, 551), false); // lệch gốc
  assert.equal(isFullFrameShot(0, 10, 880, 551, 880, 551), false);
  // Crop hợp lệ chạm góc trên-trái nhưng chỉ 1/4 khung — không phải nền.
  assert.equal(isFullFrameShot(0, 0, 440, 240, 880, 551), false);
});

test("isFullFrameShot: chưa có cỡ đích (meta chưa tới) thì không đoán", () => {
  assert.equal(isFullFrameShot(0, 0, 880, 551, 0, 0), false);
  assert.equal(isFullFrameShot(0, 0, 1600, 1000, 0, 0), false);
  assert.equal(isFullFrameShot(0, 0, 880, 551, 880, 0), false); // thiếu chiều cao
});