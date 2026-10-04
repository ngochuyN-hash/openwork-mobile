// Test logic thuần CUỘN MÀN CHAT (lib/chat-scroll.js). Hồi quy cho các bug:
//   1. Mở phiên dài phải tới đáy (trước đây ra tin cũ nhất).
//   2. Auto-follow không được chết vì một khối text dài.
//   3. Lướt lên đọc thì không bị kéo xuống, nhưng vẫn đếm đúng tin mới.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOTTOM_FOLLOW_PX,
  distanceFromBottom,
  isAtBottom,
  jumpLabel,
  keepsAutoScroll,
  leftBottomBy,
  newMessagesSince,
  scrollPlan,
  shouldShowJump,
} from "../src/lib/chat-scroll.js";

const bot = (id, text = "") => ({ info: { id, role: "assistant" }, parts: [{ type: "text", text }] });
const user = (id) => ({ info: { id, role: "user" }, parts: [{ type: "text", text: id }] });

// ---- Đo khoảng cách tới đáy ----

test("distanceFromBottom đo bằng scrollHeight - viewport - scrollY", () => {
  assert.equal(distanceFromBottom({ scrollHeight: 5000, viewportHeight: 800, scrollY: 0 }), 4200);
  assert.equal(distanceFromBottom({ scrollHeight: 5000, viewportHeight: 800, scrollY: 4200 }), 0);
});

test("trang ngắn hơn viewport thì khoảng cách là 0, không phải số âm", () => {
  // Không có clamp thì `isAtBottom` so số âm với ngưỡng vẫn đúng, nhưng nút
  // "về đáy" lại hiện lên màn trống — đó là lý do phải clamp.
  assert.equal(distanceFromBottom({ scrollHeight: 300, viewportHeight: 800, scrollY: 0 }), 0);
  assert.equal(isAtBottom(0), true);
});

test("số đo rác không được biến thành 'kéo người dùng xuống đáy'", () => {
  // Không đo được = coi như không biết, nên đứng yên; tuyệt đối không tự cuộn.
  assert.equal(distanceFromBottom({ scrollHeight: NaN, viewportHeight: undefined, scrollY: null }), 0);
  assert.equal(isAtBottom(NaN), true);
  assert.equal(isAtBottom(undefined), true);
  assert.equal(isAtBottom(null), true);
});

test("isAtBottom dùng đúng ngưỡng 260px", () => {
  assert.equal(BOTTOM_FOLLOW_PX, 260);
  assert.equal(isAtBottom(260), true);
  assert.equal(isAtBottom(261), false);
  assert.equal(isAtBottom(5000, 400), false);
  assert.equal(isAtBottom(-10), true); // số âm vẫn là "ở đáy"
});

// ---- scrollPlan: quyết định chính của cả màn ----

test("lần đầu vào phiên (forced) cuộn TỚI ĐÁY dù transcript dài bao nhiêu", () => {
  // Bug "mở phiên dài thấy tin cũ nhất": code cũ đo gap SAU khi render nên
  // scrollY=0 + scrollHeight dài => gap hàng nghìn px => bỏ qua lệnh cuộn.
  assert.equal(scrollPlan({ forced: true, atBottom: false }), "instant");
  assert.equal(scrollPlan({ forced: true, atBottom: true }), "instant");
});

test("đang bám đáy thì cuộn smooth kể cả khối mới dài hơn ngưỡng", () => {
  // Bug "đứng giữa màn khi stream": ngưỡng 260px cũ đo sau render, một khối
  // text 900px là auto-follow bỏ luôn. Ở đây atBottom là vị trí thật trước đó.
  assert.equal(scrollPlan({ forced: false, atBottom: true }), "smooth");
});

test("người dùng lướt lên đọc thì KHÔNG kéo xuống", () => {
  assert.equal(scrollPlan({ forced: false, atBottom: false }), "hold");
});

test("gọi không có tham số thì mặc định bám đáy (an toàn cho màn chat)", () => {
  assert.equal(scrollPlan(), "smooth");
});

// ---- Đếm tin mới ----

test("newMessagesSince chỉ đếm tin nối mới vào đuôi", () => {
  const before = [user("msg_1"), bot("msg_2")];
  const after = [...before, user("msg_3"), bot("msg_4")];
  assert.equal(newMessagesSince(before, after), 2);
  assert.equal(newMessagesSince(after, after), 0);
  assert.equal(newMessagesSince(after, []), 0);
});

test("lúc stream, đổi part của cùng một tin KHÔNG nhảy số", () => {
  // Cùng id, text dài thêm 200 lần — đếm part sẽ ra số 200 lung tung.
  const before = [bot("msg_a", "x")];
  const after = [bot("msg_a", "x".repeat(20000))];
  assert.equal(newMessagesSince(before, after), 0);
});

test("tin optimistic đổi id thành tin thật KHÔNG bị đếm thành hai", () => {
  // `local-…` lúc gửi, engine trả `msg_…` ở đúng chỗ đó. Cách cũ (đếm mọi id
  // chưa từng thấy ở bất kỳ vị trí nào) báo 2 cho MỘT tin.
  const before = [user("msg_1"), { info: { id: "local-7", role: "user" }, parts: [] }];
  const after = [user("msg_1"), user("msg_2")];
  assert.equal(newMessagesSince(before, after), 1);
});

test("list bị thay hẳn (không còn tin nào quen) thì không đoán bừa", () => {
  // Không có mốc = không có căn cứ để nói "có bao nhiêu tin mới". Báo cả
  // transcript là tin mới là sai; báo 0 là thành thật.
  const before = [user("msg_1"), user("msg_2")];
  const after = [user("msg_9"), user("msg_8"), user("msg_7")];
  assert.equal(newMessagesSince(before, after), 0);
});

test("tin chèn ở đầu danh sách không phải tin mới", () => {
  const before = [user("msg_2")];
  const after = [user("msg_1"), user("msg_2")];
  assert.equal(newMessagesSince(before, after), 0);
});

test("vào phiên mới (trước đó chưa có gì) thì mọi tin đều tính là mới", () => {
  const after = [user("msg_1"), bot("msg_2")];
  assert.equal(newMessagesSince(null, after), 2);
  assert.equal(newMessagesSince([], after), 2);
});

test("xoá tin cuối rồi thêm tin mới vẫn đếm đúng phần nối thêm", () => {
  const before = [user("msg_1"), bot("msg_2")];
  const after = [user("msg_1"), bot("msg_3")]; // msg_2 bị xoá, msg_3 là tin mới
  assert.equal(newMessagesSince(before, after), 1);
});

test("tin không có id thì bỏ qua, không đếm nhầm tin rác", () => {
  assert.equal(newMessagesSince([], [{ info: {} }, { parts: [] }]), 0);
  assert.equal(newMessagesSince([], [user("local-1"), user("local-1")]), 1);
});

// ---- Cờ "đang cuộn bằng lệnh của app" ----
// Đây là chốt chặn bug lớn nhất: lệnh cuộn của app bị đọc thành người dùng
// đang lướt lên → tự cuộn chết giữa lúc stream.

test("đang cuộn tự động thì GIỮ cờ, kể cả khi khoảng cách tạm lớn", () => {
  // Smooth scroll còn chạy thì gap còn lớn; nếu thả cờ ở đây thì chính lệnh
  // cuộn của ta giết chính nó.
  assert.equal(keepsAutoScroll({ autoScroll: true, gap: 900, movedUp: false }), true);
});

test("tới nơi thì thả cờ", () => {
  assert.equal(keepsAutoScroll({ autoScroll: true, gap: 0, movedUp: false }), false);
  assert.equal(keepsAutoScroll({ autoScroll: true, gap: 3, movedUp: false }), false);
});

test("người dùng kéo NGƯỢC lên thì thả cờ ngay", () => {
  assert.equal(keepsAutoScroll({ autoScroll: true, gap: 900, movedUp: true }), false);
});

test("chưa cuộn tự động thì không giữ cờ", () => {
  assert.equal(keepsAutoScroll({ autoScroll: false, gap: 0, movedUp: false }), false);
});

// ---- Vuốt lên = rời vùng bám ----

test("VUỐT LÊN là rời đáy ngay, không chờ vượt ngưỡng 260px", () => {
  // Nếu phải vượt 260px mới thoát được thì lúc agent đang stream (mỗi nhịp
  // đều ra lệnh cuộn) người dùng gần như không lướt lên đọc nổi.
  assert.equal(leftBottomBy({ autoScroll: false, gap: 30, movedUp: true }), true);
  assert.equal(leftBottomBy({ autoScroll: false, gap: 0, movedUp: true }), true);
});

test("đứng yên trong vùng bám vẫn là đang ở đáy", () => {
  assert.equal(leftBottomBy({ autoScroll: false, gap: 0, movedUp: false }), false);
  assert.equal(leftBottomBy({ autoScroll: false, gap: 259, movedUp: false }), false);
  assert.equal(leftBottomBy({ autoScroll: false, gap: 261, movedUp: false }), true);
});

test("đang cuộn bằng lệnh của app thì không ai được coi là rời đáy", () => {
  assert.equal(leftBottomBy({ autoScroll: true, gap: 900, movedUp: true }), false);
});

// ---- Nút nhảy về đáy ----

test("nút chỉ hiện khi đang lịch sử và có tin để cuộn tới", () => {
  assert.equal(shouldShowJump({ atBottom: false, visibleCount: 12 }), true);
  assert.equal(shouldShowJump({ atBottom: true, visibleCount: 12 }), false);
  assert.equal(shouldShowJump({ atBottom: false, visibleCount: 0 }), false);
});

test("chữ nút đếm đúng", () => {
  assert.equal(jumpLabel(0), "Latest message");
  assert.equal(jumpLabel(1), "1 new messages");
  assert.equal(jumpLabel(7), "7 new messages");
  assert.equal(jumpLabel(-3), "Latest message");
});