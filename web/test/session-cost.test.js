// Test logic tiền phiên (lib/session-cost.js). Shape lấy từ hợp đồng engine
// opencode: AssistantMessage.info.cost + info.tokens{input,output,reasoning,
// cache{read,write}}, transcript trả [{info, parts}]; Session v1 KHÔNG có cost
// (chỉ v2 mới có) — đó là lý do phải cộng theo tin.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toAmount,
  roundCost,
  messageCost,
  messageCostOrNull,
  messageTokens,
  sumMessageCost,
  sumMessageTokens,
  resolveSessionCost,
  resolveSessionTokens,
  formatTokens,
  costViewModel,
} from "../src/lib/session-cost.js";

const ask = (id) => ({ info: { id, role: "user" }, parts: [{ type: "text", text: "a" }] });
const reply = (id, cost, tokens) => ({
  info: { id, role: "assistant", ...(cost === undefined ? {} : { cost }), ...(tokens ? { tokens } : {}) },
  parts: [{ type: "text", text: "b" }],
});

// ---- Nhận diện giá trị: phân biệt "không có số" với "bằng 0" ----

test("toAmount chấp nhận số và chuỗi số, trả null cho thứ vô nghĩa", () => {
  assert.equal(toAmount(0.0123), 0.0123);
  assert.equal(toAmount("0.0123"), 0.0123); // engine/bản cũ trả string
  assert.equal(toAmount(0), 0);
  assert.equal(toAmount(null), null);
  assert.equal(toAmount(undefined), null);
  assert.equal(toAmount(""), null);
  assert.equal(toAmount(true), null);
  assert.equal(toAmount(-1), null); // cost âm là dữ liệu hỏng, coi như không có
  assert.equal(toAmount("abc"), null);
  assert.equal(toAmount(NaN), null);
  assert.equal(toAmount(Infinity), null);
});

test("roundCost dẹp lỗi cộng dồn của số thập phân", () => {
  assert.equal(roundCost(0.1 + 0.2), 0.3);
});

// ---- Cost của từng tin ----

test("messageCost đọc info.cost (tin user không có cost -> 0)", () => {
  assert.equal(messageCost(reply("msg_1", 0.0123)), 0.0123);
  assert.equal(messageCost(ask("msg_0")), 0);
  assert.equal(messageCostOrNull(ask("msg_0")), null); // "không có" khác "bằng 0"
  assert.equal(messageCostOrNull(reply("msg_1", 0)), 0); // model miễn phí: có 0 thật
  assert.equal(messageCost(null), 0);
});

test("messageCost chấp nhận cả shape trần {cost} không bọc info", () => {
  assert.equal(messageCost({ cost: 0.5 }), 0.5);
});

// ---- Token của từng tin ----

test("messageTokens đọc shape lồng nhau của engine v1", () => {
  const t = messageTokens(reply("msg_1", 0.01, { input: 100, output: 20, reasoning: 5, cache: { read: 8, write: 2 } }));
  assert.deepEqual(t, { input: 100, output: 20, reasoning: 5, cacheRead: 8, cacheWrite: 2, total: 135 });
});

test("messageTokens nhận cache phẳng và tên kiểu OpenAI", () => {
  const t = messageTokens(reply("msg_1", 0.01, { prompt: 10, completion: 3, cacheRead: 1, cache_write: 2 }));
  assert.equal(t.input, 10);
  assert.equal(t.output, 3);
  assert.equal(t.cacheRead, 1);
  assert.equal(t.cacheWrite, 2);
  assert.equal(t.total, 16);
});

test("messageTokens thiếu tokens -> toàn 0, không ném", () => {
  assert.equal(messageTokens(ask("msg_0")).total, 0);
  assert.equal(messageTokens(null).total, 0);
});

// ---- Cộng dồn cả transcript ----

test("sumMessageCost chỉ cộng tin có cost, không lệch số thập phân", () => {
  const list = [ask("msg_0"), reply("msg_1", 0.1), ask("msg_2"), reply("msg_3", 0.2)];
  assert.equal(sumMessageCost(list), 0.3); // không phải 0.30000000000000004
  assert.equal(sumMessageCost([]), 0);
  assert.equal(sumMessageCost(null), 0);
});

test("sumMessageTokens cộng từng nhóm của mọi tin", () => {
  const list = [
    ask("msg_0"),
    reply("msg_1", 0.1, { input: 100, output: 10, cache: { read: 5, write: 1 } }),
    reply("msg_3", 0.2, { input: 50, output: 20, reasoning: 7 }),
  ];
  assert.deepEqual(sumMessageTokens(list), {
    input: 150,
    output: 30,
    reasoning: 7,
    cacheRead: 5,
    cacheWrite: 1,
    total: 193,
  });
});

// ---- Chọn nguồn: đây là chỗ dữ liệu có, màn hình không vẽ ----

test("engine v1 (Session KHÔNG có cost): tiền lấy từ CỘNG các tin assistant", () => {
  const session = { id: "ses_1", title: "phiên nháp" }; // đúng shape v1: không cost
  const messages = [ask("msg_0"), reply("msg_1", 0.0123), reply("msg_3", 0.0077)];
  const r = resolveSessionCost(session, messages);
  assert.equal(r.source, "messages");
  assert.equal(r.counted, 2);
  assert.equal(r.cost, 0.02);
});

test("engine v2 (Session có cost) vẫn ưu tiên tổng theo tin khi tin có cost", () => {
  const session = { id: "ses_1", cost: 99, tokens: { input: 1 } };
  const r = resolveSessionCost(session, [ask("msg_0"), reply("msg_1", 0.25)]);
  assert.equal(r.source, "messages");
  assert.equal(r.cost, 0.25);
});

test("không tin nào có cost thì rơi về session.cost (v2), không có gì -> none", () => {
  const session = { id: "ses_1", cost: 1.5 };
  assert.deepEqual(resolveSessionCost(session, [ask("msg_0")]), { cost: 1.5, source: "session", counted: 0 });
  assert.deepEqual(resolveSessionCost({ id: "ses_1" }, []), { cost: 0, source: "none", counted: 0 });
  assert.deepEqual(resolveSessionCost(null, null), { cost: 0, source: "none", counted: 0 });
});

test("tin có cost 0 (model miễn phí) thì vẫn lấy theo tin, không rơi về session", () => {
  const r = resolveSessionCost({ id: "ses_1", cost: 4 }, [reply("msg_1", 0)]);
  assert.deepEqual(r, { cost: 0, source: "messages", counted: 1 });
});

test("resolveSessionTokens: cộng theo tin, thiếu thì lấy session.tokens (v2)", () => {
  assert.equal(resolveSessionTokens({}, [reply("msg_1", 0, { input: 7, output: 3 })]).total, 10);
  assert.equal(resolveSessionTokens({ tokens: { input: 4, output: 2, cache: { read: 1 } } }, []).total, 7);
  assert.equal(resolveSessionTokens(null, null).total, 0);
});

// ---- Định dạng ----

test("formatTokens gọn kiểu Việt, 0 khi chưa có token", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(null), "0");
  assert.equal(formatTokens(842), "842");
  assert.equal(formatTokens(12345), "12,3K");
  assert.equal(formatTokens(1_234_567), "1,2Tr");
});

test("costViewModel dựng nhãn cho đầu phiên, rỗng khi chưa có gì", () => {
  const v = costViewModel(
    { id: "ses_1" },
    [ask("msg_0"), reply("msg_1", 0.0123, { input: 12000, output: 800 })]
  );
  assert.equal(v.source, "messages");
  assert.equal(v.hasCost, true);
  // >0.01 thì formatCost (session-ops.js:217) làm tròn 2 chữ số
  assert.equal(v.usd, "$0.01");
  assert.equal(v.tokenLabel, "12,8K token");
  assert.equal(v.label, "$0.01 · 12,8K token");
});

test("costViewModel phiên mới mở: không in $0.00, label rỗng", () => {
  const v = costViewModel({ id: "ses_1" }, []);
  assert.equal(v.hasCost, false);
  assert.equal(v.usd, "");
  assert.equal(v.label, "");
});

test("costViewModel chỉ có token (chưa có cost) thì vẫn hiện được phần token", () => {
  const v = costViewModel({ id: "ses_1" }, [reply("msg_1", 0, { input: 500, output: 500 })]);
  assert.equal(v.usd, "");
  assert.equal(v.label, "1K token");
});