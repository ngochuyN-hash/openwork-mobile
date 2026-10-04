// Test logic thuần NÉN HỘI THOẠI (lib/session-compact.js). Shape message lấy
// đúng từ engine: {info:{id, role, tokens?}, parts:[{type:'text', text}]}.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_THRESHOLDS,
  countUserTurns,
  findLastSummaryIndex,
  turnsSinceSummary,
  lastTurnTokens,
  shouldSuggestCompact,
  compactHintVi,
  compactBlockReason,
  buildSummarizeBody,
  buildCompactCommandBody,
  summarizePath,
  formatSummaryText,
  summaryView,
} from "../src/lib/session-compact.js";

const user = (id) => ({ info: { id, role: "user" }, parts: [{ type: "text", text: id }] });
const bot = (id, tokens) => ({
  info: { id, role: "assistant", ...(tokens ? { tokens } : {}) },
  parts: [{ type: "text", text: id }],
});

/** Transcript n lượt: user/bot xen kẽ, giống hệt lịch sử thật. */
function turns(n, tokens) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(user(`msg_u${i}`));
    out.push(bot(`msg_a${i}`, tokens));
  }
  return out;
}

// ---- Đếm lượt ----

test("countUserTurns chỉ đếm tin người dùng, chấp nhận cả shape phẳng", () => {
  const list = [
    { info: { id: "msg_1", role: "user" }, parts: [] },
    bot("msg_2"),
    { role: "user", id: "flat-1" }, // shape phẳng
    { info: { id: "msg_3", role: "assistant" }, parts: [] },
  ];
  assert.equal(countUserTurns(list), 2);
  assert.equal(countUserTurns(null), 0);
});

// ---- Ngưỡng: chưa tới / gợi ý / gấp ----

test("phiên ngắn thì không gợi ý nén", () => {
  const v = shouldSuggestCompact({ messages: turns(5) });
  assert.equal(v.suggest, false);
  assert.equal(v.level, "none");
  assert.equal(v.turns, 5);
});

test("vượt ngưỡng thì gợi ý, quá ngưỡng gấp thì nói gấp", () => {
  const hint = shouldSuggestCompact({ messages: turns(COMPACT_THRESHOLDS.hint) });
  assert.equal(hint.level, "hint");
  assert.equal(hint.suggest, true);
  const urgent = shouldSuggestCompact({ messages: turns(COMPACT_THRESHOLDS.urgent + 1) });
  assert.equal(urgent.level, "urgent");
});

test("lượt cuối ăn hết context thì gợi ý dù phiên mới có vài lượt", () => {
  const v = shouldSuggestCompact({ messages: turns(3, { input: 90_000, output: 40_000, cache: { read: 5_000 } }) });
  assert.equal(v.level, "hint");
  assert.equal(v.tokens, 135_000);
  assert.equal(v.reason, "lượt gần nhất đã nặng");
});

test("agent đang chạy thì không gợi ý (lượt đang stream sẽ lệch)", () => {
  const v = shouldSuggestCompact({ messages: turns(40), running: true });
  assert.equal(v.suggest, false);
  assert.equal(v.reason, "agent đang chạy");
});

test("vừa nén xong thì im một lúc, đủ lượt rồi mới gợi ý lại", () => {
  const v = shouldSuggestCompact({
    messages: turns(40),
    sinceLastCompact: COMPACT_THRESHOLDS.cooldown - 1,
  });
  assert.equal(v.suggest, false);
  assert.equal(v.turnsSince, COMPACT_THRESHOLDS.cooldown - 1);
  assert.equal(v.reason, "vừa nén xong, để agent làm tiếp đã");
  // Đủ lượt kể từ lần nén là gợi ý lại
  assert.equal(shouldSuggestCompact({ messages: turns(40), sinceLastCompact: COMPACT_THRESHOLDS.hint }).level, "hint");
});

test("phiên chưa nén bao giờ thì KHÔNG bị cooldown vô lý chặn", () => {
  const v = shouldSuggestCompact({ messages: turns(3), thresholds: { hint: 3, urgent: 99 } });
  assert.equal(v.level, "hint");
  assert.equal(v.turnsSince, null);
  assert.equal(v.turns, 3);
});

test("truyền ngưỡng riêng để test nhanh", () => {
  const v = shouldSuggestCompact({ messages: turns(3), thresholds: { hint: 3, urgent: 99 } });
  assert.equal(v.level, "hint");
  assert.equal(v.turns, 3);
});

// ---- Đếm từ lần nén (cờ summary của engine) ----

test("cờ info.summary của engine là mốc đếm lượt sau khi nén", () => {
  const list = [...turns(6), { info: { id: "msg_sum", role: "assistant", summary: true }, parts: [{ type: "text", text: "Tóm tắt" }] }, ...turns(2)];
  assert.equal(findLastSummaryIndex(list), list.length - 5);
  // Cờ engine thắng số lượt UI tự đếm
  assert.equal(turnsSinceSummary(list, 99), 2);
  assert.equal(shouldSuggestCompact({ messages: list }).level, "none"); // 2 lượt sau nén -> im
});

test("engine không bật cờ summary thì dùng số lượt UI tự đếm", () => {
  assert.equal(findLastSummaryIndex(turns(5)), -1);
  assert.equal(turnsSinceSummary(turns(5), null), null);
  assert.equal(turnsSinceSummary(turns(5), 7), 7);
});

// ---- Token của lượt cuối ----

test("lastTurnTokens lấy lượt assistant GẦN NHẤT, chỉ tính input+output+cache.read", () => {
  const list = [
    bot("msg_a1", { input: 100, output: 20, reasoning: 999, cache: { read: 5, write: 7 } }),
    user("msg_u2"),
    bot("msg_a2", { input: 1_000, output: 200, cache: { read: 300 } }),
  ];
  assert.equal(lastTurnTokens(list), 1_500);
  assert.equal(lastTurnTokens(turns(2)), 0);
  assert.equal(lastTurnTokens(null), 0);
});

// ---- Câu gợi ý + lý do chặn ----

test("compactHintVi đổi lời theo mức, rỗng khi chưa tới lúc", () => {
  assert.equal(compactHintVi("none"), "");
  assert.match(compactHintVi("hint", { turnsSince: 12 }), /12 lượt/);
  assert.match(compactHintVi("urgent", { turnsSince: 25 }), /sắp quên việc đang dở/);
  // Không biết số lượt thì vẫn đọc được, không in "null lượt"
  assert.doesNotMatch(compactHintVi("hint"), /null/);
});

test("compactBlockReason nói rõ vì sao chưa nén được", () => {
  assert.equal(compactBlockReason({ turns: 10 }), "");
  assert.match(compactBlockReason({ turns: 10, running: true }), /Agent đang chạy/);
  assert.match(compactBlockReason({ turns: 1 }), /Mới có vài tin/);
  assert.match(compactBlockReason({ turns: 10, busy: true }), /Đang nén rồi/);
});

// ---- Body hai đường nén: KHÁC NHAU ----
// parseModelId không còn là export riêng — dùng chung parseModelValue của
// lib/model-behavior.js (trước đây bản split("/") hai đoạn đã từng mất
// modelID chứa dấu "/" ở giữa). Test qua body builder để bám đúng consumer.

test("summarize nhận TỪNG field providerID/modelID, không có model chuỗi", () => {
  assert.deepEqual(buildSummarizeBody("openai/gpt-5"), { providerID: "openai", modelID: "gpt-5" });
  // KHÔNG có provider/model dạng chuỗi, KHÔNG có directory
  assert.deepEqual(Object.keys(buildSummarizeBody("openai/gpt-5")).sort(), ["modelID", "providerID"]);
  assert.equal(buildSummarizeBody(""), null);
});

test("model id có dấu '/' ở giữa giữ nguyên — chỉ cắt ở dấu đầu tiên", () => {
  // openrouter/anthropic/claude-sonnet-4: provider=openrouter, model=phần còn lại.
  assert.deepEqual(buildSummarizeBody("openrouter/anthropic/claude-sonnet-4"), {
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4",
  });
  assert.equal(buildSummarizeBody("khong-co-dau-gach"), null);
});

test("đường dự phòng command 'compact' thì model LẠI là chuỗi", () => {
  assert.deepEqual(buildCompactCommandBody("openai/gpt-5"), {
    command: "compact",
    arguments: "",
    model: "openai/gpt-5",
  });
  assert.equal(buildCompactCommandBody("gpt-5"), null);
});

test("summarizePath đúng mount của engine, directory đi qua query", () => {
  assert.equal(
    summarizePath("ws 1", "ses_a/b"),
    "/workspace/ws%201/opencode/session/ses_a%2Fb/summarize"
  );
  assert.equal(
    summarizePath("ws1", "ses1", { directory: "C:/proj x" }),
    "/workspace/ws1/opencode/session/ses1/summarize?directory=C%3A%2Fproj%20x"
  );
  // Không directory thì không dính dấu "?" thừa
  assert.ok(!summarizePath("ws1", "ses1").includes("?"));
});

// ---- Định dạng phần tóm tắt ----

test("formatSummaryText cắt cho vừa điện thoại, luôn báo đã cắt", () => {
  assert.deepEqual(formatSummaryText(""), { text: "", truncated: false, total: 0 });
  assert.deepEqual(formatSummaryText(null), { text: "", truncated: false, total: 0 });
  const short = formatSummaryText("  tóm tắt ngắn  ", 100);
  assert.equal(short.text, "tóm tắt ngắn");
  assert.equal(short.truncated, false);

  const long = "a".repeat(400);
  const cut = formatSummaryText(long, 100);
  assert.equal(cut.truncated, true);
  assert.equal(cut.total, 400);
  assert.ok(cut.text.endsWith("…"));

  // Bản tóm tắt là markdown nhiều dòng -> cắt ở DÒNG trước, không cắt giữa
  const md = `${"x".repeat(50)}\n${"y".repeat(50)}\n${"z".repeat(200)}`;
  const cutMd = formatSummaryText(md, 120);
  assert.equal(cutMd.truncated, true);
  assert.ok(!cutMd.text.includes("z"));
});

test("summaryView lấy tin tóm tắt mới nhất, không có thì null", () => {
  assert.equal(summaryView(turns(4)), null);
  const list = [
    { info: { id: "msg_s1", role: "assistant", summary: true }, parts: [{ type: "text", text: "bản cũ" }] },
    bot("msg_a2"),
    {
      info: { id: "msg_s2", role: "assistant", summary: true },
      parts: [{ type: "text", text: "dòng 1" }, { type: "file" }, { type: "text", text: "dòng 2" }],
    },
  ];
  const v = summaryView(list);
  assert.equal(v.messageId, "msg_s2");
  assert.equal(v.text, "dòng 1\ndòng 2");
  assert.equal(v.truncated, false);
  assert.equal(v.role, "assistant");
});
// ---- Lỗi cũ: cắt trúng giữa emoji làm ký tự hỏng ----

test("formatSummaryText không cắt đôi emoji (ký tự hỏng ở mép cắt)", () => {
  const text = `${"a".repeat(90)}😀${"b".repeat(90)}`;
  const cut = formatSummaryText(text, 100);
  assert.equal(cut.truncated, true);
  // Không được còn ký tự thay thế U+FFFD do cắt giữa cặp thay thế.
  assert.ok(!cut.text.includes("\uFFFD"), `bản cắt có ký tự hỏng: ${JSON.stringify(cut.text)}`);
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.text.replace("…", "")), "không dừng giữa nửa emoji");
  assert.ok(cut.text.endsWith("…"));
});

test("formatSummaryText: ký tự có dấu tiếng Việt vẫn cắt đúng (BMP = 1 đơn vị)", () => {
  const text = "ỗ".repeat(200);
  const cut = formatSummaryText(text, 100);
  assert.equal(cut.text, `${"ỗ".repeat(100)}…`);
});
