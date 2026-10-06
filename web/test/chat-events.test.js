// lib/chat-events.js — bộ nhận dạng event SSE của engine (tách từ chat.jsx).
import { test } from "node:test";
import assert from "node:assert/strict";

import { eventSessionId, sameSession, eventProps } from "../src/lib/chat-events.js";

test("eventSessionId: nhận hết các biến thể tên trường của engine", () => {
  assert.equal(eventSessionId({ sessionID: "ses_a" }), "ses_a");
  assert.equal(eventSessionId({ sessionId: "ses_b" }), "ses_b");
  assert.equal(eventSessionId({ session_id: "ses_c" }), "ses_c");
  assert.equal(eventSessionId({ properties: { sessionID: "ses_d" } }), "ses_d");
  assert.equal(eventSessionId({ properties: { sessionId: "ses_e" } }), "ses_e");
  assert.equal(eventSessionId({ message: { sessionID: "ses_f" } }), "ses_f");
  assert.equal(eventSessionId({ part: { sessionId: "ses_g" } }), "ses_g");
  // Không có / sai kiểu → rỗng, không ném.
  assert.equal(eventSessionId({}), "");
  assert.equal(eventSessionId(null), "");
  assert.equal(eventSessionId("text"), "");
  assert.equal(eventSessionId(undefined), "");
});

test("sameSession: event chung luôn nhận; sai session thì bỏ; phớt lờ tiền tố ses_", () => {
  assert.equal(sameSession("", "ses_a"), true); // permission/connection chung
  assert.equal(sameSession("ses_a", "ses_a"), true);
  assert.equal(sameSession("ses_a", "a"), true); // khác tiền tố, cùng id
  assert.equal(sameSession("a", "ses_a"), true);
  assert.equal(sameSession("ses_b", "ses_a"), false);
  assert.equal(sameSession("b", "a"), false);
});

test("eventProps: đọc properties, fallback part, fallback gốc; sai kiểu → {}", () => {
  assert.deepEqual(eventProps({ type: "x", properties: { id: 1 } }), { id: 1 });
  assert.deepEqual(eventProps({ type: "x", part: { id: 2 } }), { id: 2 });
  assert.deepEqual(eventProps({ type: "x", id: 3 }), { type: "x", id: 3 });
  assert.deepEqual(eventProps(null), {});
  assert.deepEqual(eventProps("text"), {});
  assert.deepEqual(eventProps({ properties: "hỏng" }), {});
});
