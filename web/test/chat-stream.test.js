// Test reducer stream chat (lib/chat-stream.js) với shape event THẬT chụp
// từ engine (18/10: delta 1 ký tự, field "text", chìa partID).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatStream, mergeRefetchKeepInflight } from "../src/lib/chat-stream.js";

const partUpdated = (messageId, part) => ({
  type: "message.part.updated",
  properties: { sessionID: "ses_x", messageID: messageId, part },
});
const partDelta = (messageId, partId, delta) => ({
  type: "message.part.delta",
  properties: { sessionID: "ses_x", messageID: messageId, partID: partId, field: "text", delta },
});
const messageUpdated = (message) => ({ type: "message.updated", properties: { message } });

test("delta tới trước snapshot — seed đúng một lần, không nhân đôi", () => {
  const s = createChatStream();
  let msgs = [];
  // 3 delta rơi vào part chưa khai báo
  for (const ch of ["đ", "ỏ", " nên"]) msgs = s.apply(msgs, partDelta("m1", "p1", ch));
  assert.equal(msgs.length, 0); // chưa có gì để render
  assert.ok(s.hasPending());
  // part.updated khai báo với snapshot cộng dồn "đỏ nên"
  msgs = s.apply(msgs, partUpdated("m1", { id: "p1", type: "text", text: "đỏ nên" }));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].parts[0].text, "đỏ nên"); // dài hơn/nhau thì lấy một
  assert.ok(!s.hasPending());
  // flush không nhân thêm gì
  assert.equal(s.flush(msgs), msgs);
});

test("delta sau khi part khai báo — flush nối vào đúng part", () => {
  const s = createChatStream();
  let msgs = s.apply([], partUpdated("m1", { id: "p1", type: "text", text: "Xin" }));
  msgs = s.apply(msgs, partDelta("m1", "p1", " chào"));
  msgs = s.apply(msgs, partDelta("m1", "p1", " bạn"));
  assert.equal(msgs[0].parts[0].text, "Xin"); // chưa flush
  msgs = s.flush(msgs);
  assert.equal(msgs[0].parts[0].text, "Xin chào bạn");
  // delta của part đã tiêu — flush lần nữa không nối lại
  assert.equal(s.flush(msgs), msgs);
});

test("hai part trong một message — delta không lẫn dòng", () => {
  const s = createChatStream();
  let msgs = s.apply([], partUpdated("m1", { id: "p1", type: "text", text: "thân" }));
  msgs = s.apply(msgs, partUpdated("m1", { id: "p2", type: "reasoning", text: "" }));
  msgs = s.apply(msgs, partDelta("m1", "p2", "suy luận riêng"));
  msgs = s.apply(msgs, partDelta("m1", "p1", " thiện"));
  msgs = s.flush(msgs);
  assert.equal(msgs[0].parts[0].text, "thân thiện");
  assert.equal(msgs[0].parts[1].text, "suy luận riêng");
});

test("message.updated chốt role và parts, không đè phần đang stream bằng rỗng", () => {
  const s = createChatStream();
  let msgs = s.apply([], partUpdated("m1", { id: "p1", type: "text", text: "đang chảy" }));
  // engine gửi message.updated với parts rỗng lúc tạm nghỉ
  msgs = s.apply(msgs, messageUpdated({ id: "m1", info: { id: "m1", role: "assistant" }, parts: [] }));
  assert.equal(msgs[0].info.role, "assistant");
  assert.equal(msgs[0].parts[0].text, "đang chảy");
  // parts đầy đủ thì ghi đè
  msgs = s.apply(
    msgs,
    messageUpdated({ id: "m1", info: { id: "m1", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "xong rồi" }] })
  );
  assert.equal(msgs[0].parts[0].text, "xong rồi");
});

test("message.removed gọt message khỏi transcript", () => {
  const s = createChatStream();
  let msgs = s.apply([], partUpdated("m1", { id: "p1", type: "text", text: "a" }));
  msgs = s.apply(msgs, partUpdated("m2", { id: "p2", type: "text", text: "b" }));
  msgs = s.apply(msgs, { type: "message.removed", properties: { messageID: "m1" } });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].info.id, "m2");
});

test("part không có id — heuristic nối chữ (engine cũ)", () => {
  const s = createChatStream();
  let msgs = s.apply([], { type: "message.part.updated", properties: { messageID: "m1", part: { type: "text", text: "abc" } } });
  msgs = s.apply(msgs, { type: "message.part.updated", properties: { messageID: "m1", part: { type: "text", text: "abcd" } } });
  assert.equal(msgs[0].parts[0].text, "abcd"); // snapshot full thì thay
  msgs = s.apply(msgs, { type: "message.part.updated", properties: { messageID: "m1", part: { type: "text", text: "e" } } });
  assert.equal(msgs[0].parts[0].text, "abcde"); // delta thì nối
});

test("event lạ/sai shape — trả nguyên prev, không văng", () => {
  const s = createChatStream();
  const prev = [{ info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] }];
  assert.equal(s.apply(prev, null), prev);
  assert.equal(s.apply(prev, { type: "server.heartbeat" }), prev);
  assert.equal(s.apply(prev, { type: "session.updated", properties: {} }), prev);
  // part.updated thiếu messageID + part không có id: heuristic vẫn phải sống
  // sót — tạo stub assistant mới thay vì ném lỗi hoặc đè message có sẵn.
  const next = s.apply(prev, partUpdated("", { id: "", type: "text", text: "x" }));
  assert.equal(next.length, prev.length + 1);
  assert.equal(next[1].info.role, "assistant");
  assert.equal(next[1].parts[0].text, "x");
});

// ---- mergeRefetchKeepInflight: refetch full giữa chừng run không được làm
// mất message đang stream (transcript API chỉ flush khi xong) — mất nó là
// trang co cụm, scroll bị hất ngược lên.

test("refetch thiếu message đang stream — giữ lại message cục bộ ở cuối", () => {
  const done = { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hỏi" }] };
  const streaming = { info: { id: "m2", role: "assistant" }, parts: [{ id: "p1", type: "text", text: "chảy…" }] };
  const fetched = [done]; // máy chưa ghi xong m2
  const merged = mergeRefetchKeepInflight(fetched, [done, streaming]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], done);
  assert.equal(merged[1], streaming); // đè nguyên phần đang chạy, không cộp
});

test("refetch đủ — trả nguyên fetched, không ghép gì", () => {
  const fetched = [
    { info: { id: "m1", role: "user" }, parts: [] },
    { info: { id: "m2", role: "assistant" }, parts: [] },
  ];
  assert.equal(mergeRefetchKeepInflight(fetched, fetched), fetched);
});

test("refetch lần đầu (chưa có gì cục bộ) — fetched không đổi", () => {
  const fetched = [{ id: "m1", role: "user", parts: [] }];
  assert.equal(mergeRefetchKeepInflight(fetched, null), fetched);
  assert.equal(mergeRefetchKeepInflight(fetched, []), fetched);
  // fetched rỗng bất thường mà còn message cục bộ thì giữ — không trắng trang
  const kept = mergeRefetchKeepInflight(undefined, fetched);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "m1");
});
