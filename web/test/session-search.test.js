// Test logic thuần của ô tìm phiên (lib/session-search.js). Shape session lấy
// từ `GET /workspace/:id/opencode/session` (sessions.jsx:17) và transcript từ
// `GET /workspace/:id/opencode/session/:sid/message` (chat.jsx:136) — cùng kiểu
// session-ops.test.js: chỉ dùng dữ liệu, không mock network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuery,
  queryTerms,
  countMatches,
  snippetAround,
  sessionContentText,
  searchSessions,
  scanPlan,
  mapLimit,
} from "../src/lib/session-search.js";

const ses = (id, title, updated, extra = {}) => ({
  id,
  title,
  time: { created: updated, updated },
  ...extra,
});

const userMsg = (text) => ({ info: { id: "msg_1", role: "user" }, parts: [{ type: "text", text }] });

// ---- Chuẩn hoá ô tìm ----

test("normalizeQuery gộp khoảng trắng, bỏ khoảng trắng hai đầu, về chữ thường", () => {
  assert.equal(normalizeQuery("  Sửa   CSS  "), "sửa css");
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(undefined), "");
  assert.deepEqual(queryTerms("  sửa   css "), ["sửa", "css"]);
  assert.deepEqual(queryTerms("   "), []);
});

test("countMatches đếm không chồng lấn, không vỡ với chuỗi rỗng", () => {
  assert.equal(countMatches("aa aa", "aa"), 2);
  assert.equal(countMatches("aaaa", "aa"), 2); // không đếm chồng ("aaa" lọt)
  assert.equal(countMatches("Sửa CSS nhé", "sửa"), 1);
  assert.equal(countMatches("", "a"), 0);
  assert.equal(countMatches("abc", ""), 0);
});

// ---- Đoạn trích ----

test("snippetAround lấy cửa sổ quanh chữ khớp, không khớp thì lấy đầu đoạn", () => {
  const body = `${"đoạn rào ".repeat(40)}chỗ này có từ khoá ${" đuôi".repeat(40)}`;
  const snip = snippetAround(body, "khoá", 60);
  assert.ok(snip.includes("khoá"));
  assert.ok(snip.length <= 66);
  assert.ok(snip.startsWith("…") && snip.endsWith("…"), "cắt giữa đoạn thì phải có dấu … hai đầu");
  // Không khớp: lấy đầu, không vòng tới cuối rồi hiện "…"
  assert.ok(snippetAround("một hai ba", "zzz", 20).startsWith("một hai"));
  assert.equal(snippetAround("", "khoá"), "");
});

test("snippetAround gộp khoảng trắng và bỏ ký tự xuống dòng trong transcript", () => {
  const msg = `${"a".repeat(90)}\nbbbb\n`;
  assert.ok(!snippetAround(msg, "bbbb").includes("\n"));
});

// ---- Ghép nội dung 1 phiên ----

test("sessionContentText ghép text mọi tin, bỏ tin không text", () => {
  const text = sessionContentText([
    userMsg("câu hỏi của anh"),
    { info: { id: "msg_2", role: "assistant" }, parts: [{ type: "tool", tool: "bash" }] },
    userMsg("  "),
    userMsg("câu hỏi tiếp"),
  ]);
  assert.equal(text, "câu hỏi của anh\ncâu hỏi tiếp");
  assert.equal(sessionContentText(null), "");
});

// ---- Xếp hạng: TÊN trước NỘI DUNG ----

test("khớp tên đứng trước khớp nội dung, dù nội dung nhiều lần xuất hiện hơn", () => {
  const sessions = [ses("ses_b", "học tiếng anh", 100), ses("ses_a", "sửa lỗi css", 200)];
  const contents = { ses_b: "css css css css css" };
  const rows = searchSessions(sessions, "css", { contents });
  assert.deepEqual(rows.map((r) => r.id), ["ses_a", "ses_b"]);
  assert.equal(rows[0].matchIn, "title");
  assert.equal(rows[1].matchIn, "content");
  assert.ok(rows[1].snippet.includes("css"));
});

test("trong nhóm khớp nội dung, phiên sửa gần nhất đứng trước", () => {
  const sessions = [ses("ses_cu", "ghi chú", 100), ses("ses_moi", "ghi chú", 900), ses("ses_giua", "ghi chú", 500)];
  const contents = { ses_cu: "todo hôm nay", ses_moi: "todo hôm nay", ses_giua: "todo hôm nay" };
  assert.deepEqual(
    searchSessions(sessions, "todo", { contents }).map((r) => r.id),
    ["ses_moi", "ses_giua", "ses_cu"]
  );
});

test("cụm từ phải khớp HẾT mới ra phiên (mọi từ trong tên hoặc trong nội dung)", () => {
  const sessions = [ses("ses_1", "sửa css lỗi build", 100), ses("ses_2", "sửa lỗi build", 100)];
  const contents = { ses_1: "sửa giao diện", ses_2: "css đâu cần đổi" };
  const rows = searchSessions(sessions, "sửa css", { contents });
  // ses_1 khớp cả hai từ trong tên; ses_2 chỉ khớp "sửa" ở tên, "css" ở nội dung
  assert.deepEqual(rows.map((r) => r.id), ["ses_1", "ses_2"]);
  assert.equal(rows[0].matchIn, "title");
  assert.equal(rows[1].matchIn, "content");
  // Phiên nào thiếu một từ ở cả tên lẫn nội dung thì không ra.
  const only = searchSessions([ses("ses_3", "sửa lỗi", 1)], "sửa css", {
    contents: { ses_3: "sửa lỗi" },
  });
  assert.deepEqual(only, []);
});

test("vị trí từ khoá trong tên cũng tính: đầu tên mạnh hơn giữa tên", () => {
  const sessions = [ses("ses_giua", "làm sửa css nhanh", 900), ses("ses_dau", "sửa css", 100)];
  const rows = searchSessions(sessions, "sửa css", { contents: {} });
  assert.deepEqual(rows.map((r) => r.id), ["ses_dau", "ses_giua"]);
});

test("tìm trong tên không phân biệt hoa thường, và phiên thiếu tiêu đề không vỡ", () => {
  const sessions = [ses("ses_1", "Build CSS", 100), ses("ses_2", "", 200)];
  const rows = searchSessions(sessions, "css");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Build CSS");
  assert.equal(searchSessions([ses("ses_2", "")], "css").length, 0);
});

test("chưa gõ gì: xếp theo phiên vừa sửa, không gắn nhãn khớp", () => {
  const rows = searchSessions([ses("a", "một", 10), ses("b", "hai", 99)], "");
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
  assert.deepEqual(rows.map((r) => r.matchIn), ["", ""]);
  assert.deepEqual(rows.map((r) => r.score), [0, 0]);
});

test("limit cắt danh sách, trả về đúng shape cho UI", () => {
  const sessions = [ses("ses_1", "sửa css", 1, { wsId: "ws_9" })];
  const [row] = searchSessions(sessions, "sửa", { limit: 5 });
  assert.deepEqual(row, {
    id: "ses_1",
    wsId: "ws_9",
    title: "sửa css",
    updatedAt: 1,
    matchIn: "title",
    score: row.score,
    snippet: "",
  });
  assert.equal(searchSessions(sessions, "sửa", { limit: 0 }).length, 0);
});

test("contents nhận cả list message thô của engine, không cần bước lọc trước", () => {
  const sessions = [ses("ses_1", "phiên trắng", 1)];
  const rows = searchSessions(sessions, "openwork", { contents: { ses_1: [userMsg("mở openwork đi")] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].matchIn, "content");
  assert.ok(rows[0].snippet.includes("openwork"));
});

// ---- Chọn phiên nào tải nội dung ----

test("scanPlan ưu tiên phiên gần đây, bỏ phiên đã có trong cache", () => {
  const sessions = [ses("ses_cu", "a", 10), ses("ses_moi", "b", 99), ses("ses_giua", "c", 50)];
  assert.deepEqual(scanPlan(sessions, [], 2), ["ses_moi", "ses_giua"]);
  assert.deepEqual(scanPlan(sessions, ["ses_moi"], 5), ["ses_giua", "ses_cu"]);
  assert.deepEqual(scanPlan(sessions, new Set(["ses_cu", "ses_giua", "ses_moi"]), 5), []);
  assert.deepEqual(scanPlan(null, [], 5), []);
});

test("mapLimit giới hạn số việc chạy song song và giữ đúng thứ tự", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([10, 20, 30, 40, 50], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n / 2;
  });
  assert.deepEqual(out, [5, 10, 15, 20, 25]);
  assert.ok(peak <= 2, `đỉnh ${peak} request cùng lúc, phải ≤ 2`);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});

// ---- Lỗi cũ: từ khoá dài hơn cửa sổ làm mất đúng chữ khớp ----

test("snippetAround: từ khoá DÀU hơn cửa sổ vẫn phải thấy chữ khớp", () => {
  // Người dùng bê nguyên một câu dài vào ô tìm: cap=24 nhưng từ khoá dài 60.
  // Trước đây (cap-len)/2 âm -> cửa sổ lùi quá tay và bắt đầu SAU chữ khớp,
  // ra một đoạn trích không liên quan.
  const phrase = "sửa lỗi đăng nhập bằng mật khẩu cũ";
  const body = `${"tiền đoạn vô nghĩa. ".repeat(20)}${phrase}. hậu đoạn vô nghĩa.`;
  const snip = snippetAround(body, phrase, 24);
  assert.ok(snip.includes(phrase.slice(0, 12)), `phải thấy đầu chữ khớp, nhận "${snip}"`);
  assert.ok(snip.startsWith("…"), "vẫn đánh dấu bị cắt ở mép trước");
});

test("snippetAround: nhiều từ khoá thì lấy từ khoá xuất hiện sớm nhất", () => {
  // "đuôi" đứng sau "đầu" trong câu nhưng được gõ trước — cửa sổ phải bám
  // chỗ khớp SỚM NHẤT trong văn bản, không bám thứ tự người gõ.
  const body = `đầu tiên xuất hiện ở đây ${"đuôi ".repeat(30)}`;
  const snip = snippetAround(body, "đuôi đầu", 40);
  assert.ok(snip.includes("đầu tiên xuất hiện"), `phải mở cửa sổ quanh "đầu", nhận "${snip}"`);
});

// ---- XSS: đầu vào người dùng KHÔNG được biến thành HTML ----

test("snippet/tiêu đề giữ NGUYÊN văn bản thô — không escape sẵn, không sinh HTML", () => {
  // search.jsx render `{r.snippet}` bằng JSX (Preact tự escape khi render).
  // Vì vậy lib phải GIỮ NGUYÊN văn bản: escape sẵn ở lib thì người dùng thấy
  // "&lt;script&gt;", còn sinh/thay HTML ở lib thì đó là lỗ hổng.
  const evil = '<img src=x onerror=alert(1)>';
  const rows2 = [
    { id: "s1", title: "phiên x", time: { updated: 1 } },
    { id: "s2", title: `tiêu đề ${evil}`, time: { updated: 2 } },
  ];
  // Từ khoá "satan" chỉ nằm trong NỘI DUNG s1 — s2 có HTML trong tên nhưng
  // không chứa từ khoá, nên kết quả chỉ có s1 và là nhánh "khớp nội dung".
  const out = searchSessions(rows2, "satan", { contents: { s1: `dẫn ${evil} satan dẫn` } });
  assert.equal(out.length, 1, "chỉ phiên có nội dung chứa từ khoá");
  assert.equal(out[0].matchIn, "content");
  assert.ok(out[0].snippet.includes(evil), `đoạn trích giữ thô, nhận "${out[0].snippet}"`);
  assert.equal(out[0].snippet.includes("&lt;"), false, "KHÔNG escape sẵn ở lib");
  assert.equal(out[0].snippet.includes("&amp;"), false);

  // Nhánh khớp tên: tiêu đề giữ nguyên chuỗi thô (không escape, không cắt).
  const titled = searchSessions(rows2, "tiêu đề", {});
  assert.equal(titled[0].title, `tiêu đề ${evil}`);
  assert.equal(titled[0].snippet, "", "khớp tên thì không cần đoạn trích");
});

test("từ khoá kiểu regex không làm hỏng tìm kiếm (không dựng RegExp từ input)", () => {
  // Ô tìm dùng indexOf, không dựng RegExp — nên "(a+)+$" là từ khoá THƯỜNG,
  // không phải regex; và không có regex nào ném lỗi khiến trang sập.
  const q = "(a+)+$";
  const rows2 = [
    { id: "s1", title: `so khớp ${q}`, time: { updated: 2 } },
    { id: "s2", title: "không liên quan", time: { updated: 1 } },
  ];
  const out = searchSessions(rows2, q, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "s1");
  // Backreference / lookahead cũng phải là chuỗi thường, không ném.
  for (const weird of ["(?=x)", "\p{L}", "a{2,3}", "[", "((("]) {
    assert.doesNotThrow(() => searchSessions(rows2, weird, {}), weird);
  }
});

test("từ khoá rỗng/khoảng trắng trả về MỌI phiên — đó là lý do UI phải chặn theo phase", () => {
  const rows2 = [
    { id: "s1", title: "a", time: { updated: 5 } },
    { id: "s2", title: "b", time: { updated: 9 } },
  ];
  assert.equal(searchSessions(rows2, "", {}).length, 2, "tìm rỗng trả về danh sách, không phải kết quả");
  assert.equal(searchSessions(rows2, "   ", {}).length, 2);
  assert.equal(searchSessions(rows2, "", {}).every((r) => r.matchIn === ""), true, "chưa lọc thì không gắn nhãn khớp");
});
