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

// ---- Hồi quy do thêm tính năng steer (04/10) ----
// Trước steer, send() chặn khi agent đang chạy (`|| running) return`), nên nhánh
// refetch-giữ-tin-cục-bộ không bao giờ gặp tin client tự sinh. Sau steer thì có:
// tin vừa gửi hiện optimistically với id `local-<timestamp>`, rồi loadMessages()
// chạy lại lúc agent đang chạy. Hai lỗi dưới đây chỉ xuất hiện từ đó.

test("tin client tự sinh bị bỏ khi server đã trả bản thật — không hiện trùng", () => {
  const prev = [
    { info: { id: "msg_1", role: "user" }, parts: [] },
    { info: { id: "local-1750000000000", role: "user" }, parts: [{ id: "lp", type: "text", text: "tin vừa gửi" }] },
  ];
  // Server đã ghi tin đó và trả về bản thật (id msg_*, chữ khớp).
  const fetched = [
    { info: { id: "msg_1", role: "user" }, parts: [] },
    { info: { id: "msg_9abc", role: "user" }, parts: [{ id: "sp", type: "text", text: "tin vừa gửi" }] },
  ];
  const merged = mergeRefetchKeepInflight(fetched, prev);
  assert.equal(merged.length, 2, "không được dồn thêm bản local");
  assert.deepEqual(
    merged.map((m) => m.info.id),
    ["msg_1", "msg_9abc"],
  );
});

test("tin client tự sinh VẪN được giữ khi server chưa trả bản thật", () => {
  // Vừa gửi xong, engine chưa kịp ghi → phải giữ để người dùng thấy tin mình
  // vừa gửi, không được làm trống rồi nhảy.
  const local = { info: { id: "local-1750000000000", role: "user" }, parts: [{ id: "lp", type: "text", text: "vừa gửi" }] };
  const fetched = [{ info: { id: "msg_1", role: "user" }, parts: [] }];
  const merged = mergeRefetchKeepInflight(fetched, [fetched[0], local]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].info.id, "local-1750000000000");
});

test("tin đang stream (id thật) vẫn giữ như cũ — không bị coi là tin local", () => {
  const done = { info: { id: "msg_1", role: "user" }, parts: [] };
  const streaming = { info: { id: "msg_2", role: "assistant" }, parts: [] };
  const merged = mergeRefetchKeepInflight([done], [done, streaming]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1], streaming);
});

test("nhiều tin local cùng lúc — bỏ đúng số đã được server xác nhận", () => {
  const t1 = userMsg("local-aaa", "tin một");
  const t2 = userMsg("local-bbb", "tin hai");
  const prev = [t1, t2];
  // Server mới nhận được tin đầu, tin sau chưa.
  const fetched = [userMsg("msg_a", "tin một")];
  const merged = mergeRefetchKeepInflight(fetched, prev);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].info.id, "msg_a");
  assert.equal(merged[1].info.id, "local-bbb");
});

// ---- Fixture có chữ thật, khớp với tin engine trả về ----
const asstMsg = (id, text = "trả lời") => ({
  info: { id, role: "assistant" },
  parts: [{ id: `${id}-p1`, type: "text", text }],
});

const userMsg = (id, text, extra = {}) => ({
  info: { id, role: "user", ...extra },
  parts: [{ id: `${id}-p1`, type: "text", text }],
});

test("REGRESSION: hai đồng hồ lệch nhau KHÔNG được dùng để khớp bản thật", () => {
  // Đây là lý do bản cũ hỏng: nó so `info.time.created` của bản optimistic
  // (Date.now() CỦA ĐIỆN THOẠI) với `time.created` engine tự đóng (đồng hồ máy
  // tính). Hai con số gần như không bao giờ bằng nhau → bản optimistic sống mãi
  // cạnh bản thật: mỗi tin gửi đi hiện HAI lần, refetch lại dồn thêm bản.
  const prev = [userMsg("local-1750000000000", "tin vừa gửi", { time: { created: 1750000000000 } })];
  const fetched = [userMsg("msg_9abc", "tin vừa gửi", { time: { created: 1750000004321 } })]; // lệch 4.3 giây
  const merged = mergeRefetchKeepInflight(fetched, prev);
  assert.deepEqual(merged.map((m) => m.info.id), ["msg_9abc"], "phải bỏ bản local, chỉ giữ bản thật");
});

test("hai tin CÙNG CHỮ gửi liên tiếp — bỏ đúng một bản local, không mất tin chưa tới máy", () => {
  // Ghép sai cặp là mất tin: bỏ cả hai bản local thì tin thứ hai biến mất vĩnh viễn.
  const merged = mergeRefetchKeepInflight([userMsg("msg_1", "ok")], [userMsg("local-1", "ok"), userMsg("local-2", "ok")]);
  assert.deepEqual(merged.map((m) => m.info.id), ["msg_1", "local-2"]);
});

// ---- SSE: bản thật về theo message.updated chứ không qua refetch ----

test("SSE message.updated móc vào đúng bản optimistic, không nối thêm tin trùng", () => {
  // Đường dễ gặp nhất: sau khi gửi, message.part.updated tới trước và dựng stub
  // mang messageId thật, message.updated chốt role sau. Nếu reducer chỉ so id
  // thì tin user hiện hai lần (bản local-* + bản engine).
  const s = createChatStream();
  const local = userMsg("local-1750000000000", "sửa lỗi đăng nhập");
  let msgs = [userMsg("msg_old", "chuyện cũ"), local];
  msgs = s.apply(msgs, messageUpdated({ id: "msg_new", info: { id: "msg_new", role: "user" }, parts: [] }));
  assert.equal(msgs.length, 2, "bản optimistic phải được thay bằng bản thật, không phải nối thêm");
  assert.deepEqual(msgs.map((m) => m.info.id), ["msg_old", "msg_new"]);
});

test("SSE đến trước bản optimistic (race) — bản thật vẫn loại bản local", () => {
  const s = createChatStream();
  const msgs = s.apply(
    [userMsg("local-1", "hỏi việc này")],
    messageUpdated({ id: "msg_z", info: { id: "msg_z", role: "user" }, parts: [] }),
  );
  assert.deepEqual(msgs.map((m) => m.info.id), ["msg_z"]);
});

test("tin local CHƯA được máy nhận thì giữ nguyên, không bị xoá nhầm", () => {
  const s = createChatStream();
  const msgs = s.apply([userMsg("local-1", "mới bấm gửi")], partUpdated("msg_a", { id: "p1", type: "text", text: "ok" }));
  assert.deepEqual(msgs.map((m) => m.info.id), ["local-1", "msg_a"]);
});

test("tin assistant trùng chữ với tin user KHÔNG bị nhầm là bản thật của nó", () => {
  const s = createChatStream();
  const msgs = s.apply([userMsg("local-1", "ok")], partUpdated("msg_a", { id: "p1", type: "text", text: "ok" }));
  assert.equal(msgs.length, 2, "tin assistant phải là một message riêng");
  assert.equal(msgs[0].info.id, "local-1");
});

// ---- REGRESSION 04/10: lịch sử nuốt mất tin vừa gửi ----
// Người dùng gõ "ok" (đã hỏi 20 lượt trước), bấm Gửi, một lượt refetch do SSE
// reconnect / tab focus → tin vừa gửi biến mất khỏi màn hình cho tới khi engine
// xác nhận. Nguyên nhân: đếm tin user theo nội dung trong CẢ lịch sử rồi trừ từ
// đầu, nên tin cũ đã "tiêu" hết chỗ của tin mới.

test("lịch sử có tin cũ cùng chữ thì tin vừa gửi vẫn phải còn", () => {
  const fetched = [userMsg("msg_old", "ok"), asstMsg("a1"), asstMsg("a2")];
  const prev = [...fetched, userMsg("local-9", "ok")];
  const merged = mergeRefetchKeepInflight(fetched, prev);
  assert.ok(merged.some((m) => m.info.id === "local-9"), "tin vừa gửi không được biến mất");
  assert.equal(merged.length, 4, "không được nhân bản tin");
});

test("tin thật MỚI tới mới xác nhận được tin chờ", () => {
  const fetched = [userMsg("m1", "ok"), userMsg("msg_new", "ok")];
  const prev = [userMsg("m1", "ok"), userMsg("local-9", "ok")];
  assert.ok(!mergeRefetchKeepInflight(fetched, prev).some((m) => m.info.id === "local-9"));
});

test("hai tin cùng chữ gửi liên tiếp: xác nhận theo thứ tự gửi, giữ đúng một bản chờ", () => {
  const fetched = [userMsg("m1", "ok"), userMsg("msg_new", "ok")];
  const prev = [userMsg("m1", "ok"), userMsg("local-1", "ok"), userMsg("local-2", "ok")];
  const waiting = mergeRefetchKeepInflight(fetched, prev).filter((m) => m.info.id.startsWith("local-"));
  assert.equal(waiting.length, 1, "đúng một tin còn chờ");
  assert.equal(waiting[0].info.id, "local-2", "bản CŨ NHẤT được xác nhận trước — engine ghi theo thứ tự gửi");
});

test("chưa có tin thật nào thì giữ nguyên tin chờ", () => {
  const fetched = [userMsg("m1", "x")];
  const prev = [userMsg("m1", "x"), userMsg("local-1", "tin mới")];
  assert.ok(mergeRefetchKeepInflight(fetched, prev).some((m) => m.info.id === "local-1"));
});
