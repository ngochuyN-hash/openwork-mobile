// Test logic thuần của nút Chia sẻ phiên (lib/session-share.js).
// Shape Session lấy từ type thật của @opencode-ai/sdk@1.18.25
// (SessionShareResponses 200: Session, `share?: { url: string }`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shareUrlOf,
  isShared,
  parseShareResponse,
  shareErrorVi,
  canWebShare,
  buildShareData,
  shareLink,
  shareResultVi,
  shareButtonLabel,
} from "../src/lib/session-share.js";

const session = (over = {}) => ({ id: "ses_1", title: "Sửa đường dẫn", ...over });

// ---- Link nằm trong OBJECT share.url, không phải chuỗi ----

test("shareUrlOf đọc share.url và bỏ khoảng trắng thừa", () => {
  assert.equal(shareUrlOf(session({ share: { url: "https://s.opencode.ai/s/abc" } })), "https://s.opencode.ai/s/abc");
  assert.equal(shareUrlOf(session({ share: { url: "  https://x/y  " } })), "https://x/y");
});

test("phiên chưa bật share -> link rỗng, isShared false", () => {
  assert.equal(shareUrlOf(session()), "");
  assert.equal(shareUrlOf(session({ share: null })), "");
  assert.equal(shareUrlOf(null), "");
  assert.equal(isShared(session({ share: { url: "https://a/b" } })), true);
});

test("shareUrlOf không đoán khi field rác (số, object) — trả rỗng", () => {
  assert.equal(shareUrlOf(session({ share: "https://a/b" })), ""); // string thay vì object
  assert.equal(shareUrlOf(session({ share: { url: 42 } })), "");
});

// ---- Phân tích phản hồi endpoint ----

test("POST share trả Session có link -> ok", () => {
  const r = parseShareResponse(session({ share: { url: "https://s/abc" } }));
  assert.deepEqual(r, { ok: true, url: "https://s/abc", error: "" });
});

test("phản hồi bọc trong .data vẫn bóc được (bridge cũ / engine v2)", () => {
  const r = parseShareResponse({ data: session({ share: { url: "https://s/xyz" } }) });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://s/xyz");
});

test("200 mà không có link -> KHÔNG báo thành công, có lời tiếng Việt", () => {
  const r = parseShareResponse(session());
  assert.equal(r.ok, false);
  assert.equal(r.url, "");
  assert.match(r.error, /không trả về link/i);
});

test("DELETE share: thành công khi link đã mất khỏi Session", () => {
  const r = parseShareResponse(session(), { unshare: true });
  assert.deepEqual(r, { ok: true, url: "", error: "" });
});

test("DELETE share mà link còn -> báo chưa huỷ được, không nói thành công", () => {
  const r = parseShareResponse(session({ share: { url: "https://s/abc" } }), { unshare: true });
  assert.equal(r.ok, false);
  assert.equal(r.url, "https://s/abc");
  assert.match(r.error, /chưa huỷ được/i);
});

// ---- Lỗi -> tiếng Việt ----

test("shareErrorVi dịch 400/401/403/404/5xx của endpoint", () => {
  const at = (status) => shareErrorVi({ status, message: "HTTP " + status });
  assert.match(at(400), /từ chối/i);
  assert.match(at(401), /hết hạn/i);
  assert.match(at(403), /chỉ xem được/i);
  assert.match(at(404), /Không tìm thấy phiên/i);
  assert.match(at(503), /đang lỗi/i);
});

test("shareErrorVi hiểu UNPAIRED và lỗi mạng, không lộ HTTP thô", () => {
  assert.match(shareErrorVi(new Error("UNPAIRED")), /Chưa ghép máy tính/);
  assert.match(shareErrorVi(new TypeError("Failed to fetch")), /Không nối được tới máy tính/);
  assert.doesNotMatch(shareErrorVi(new TypeError("Failed to fetch")), /Failed to fetch/);
  // Message lạ của bridge thì trả nguyên văn, không bịa thêm.
  assert.equal(shareErrorVi(new Error("Session is running")), "Session is running");
});

// ---- Web Share API hay không ----

test("canWebShare chỉ true khi thật sự có hàm share", () => {
  assert.equal(canWebShare({ share: () => {} }), true);
  assert.equal(canWebShare({}), false);
  assert.equal(canWebShare(undefined), false);
});

test("buildShareData lấy tiêu đề phiên và link, không rỗng", () => {
  const d = buildShareData(session({ title: " Sửa link " }), "https://s/abc");
  assert.equal(d.title, "Sửa link");
  assert.equal(d.url, "https://s/abc");
  assert.match(d.text, /Sửa link/);
  // Phiên không tên -> vẫn phải có title để sheet khỏi trống
  assert.equal(buildShareData({ id: "ses_1" }, "https://s/abc").title, "Phiên trên OpenWork");
});

// ---- Chia sẻ: có sheet thì dùng sheet, không có thì chép link ----

test("có navigator.share -> mở sheet, KHÔNG chép clipboard", async () => {
  let shared = null;
  let copied = 0;
  const r = await shareLink({
    nav: { share: async (d) => { shared = d; } },
    clipboard: { writeText: async () => { copied += 1; } },
    session: session({ share: { url: "https://s/abc" } }),
    url: "https://s/abc",
  });
  assert.equal(r.via, "share");
  assert.equal(r.error, "");
  assert.equal(shared.url, "https://s/abc");
  assert.equal(copied, 0);
});

test("không có Web Share API -> chép link, báo lại bằng tiếng Việt", async () => {
  let written = "";
  const r = await shareLink({
    nav: {},
    clipboard: { writeText: async (t) => { written = t; } },
    session: session(),
    url: "https://s/abc",
  });
  assert.equal(r.via, "copy");
  assert.equal(written, "https://s/abc");
  assert.match(shareResultVi(r), /đã chép link/);
});

test("bấm Huỷ trên sheet = AbortError, KHÔNG phải lỗi (không banner đỏ)", async () => {
  const abort = Object.assign(new Error("hủy"), { name: "AbortError" });
  const r = await shareLink({
    nav: { share: async () => { throw abort; } },
    clipboard: { writeText: async () => { throw new Error("không được gọi"); } },
    session: session(),
    url: "https://s/abc",
  });
  assert.equal(r.via, "cancelled");
  assert.equal(r.error, "");
  assert.equal(shareResultVi(r), "");
});

test("share hỏng kiểu khác (không phải huỷ) -> rơi tiếp xuống chép link", async () => {
  let written = "";
  const r = await shareLink({
    nav: { share: async () => { throw new TypeError("Failed to fetch"); } },
    clipboard: { writeText: async (t) => { written = t; } },
    session: session(),
    url: "https://s/abc",
  });
  assert.equal(r.via, "copy");
  assert.equal(written, "https://s/abc");
});

test("không có cả sheet lẫn clipboard -> nói thẳng, không crash", async () => {
  const r = await shareLink({ nav: {}, session: session(), url: "https://s/abc" });
  assert.equal(r.via, "unsupported");
  assert.match(r.error, /không hỗ trợ chia sẻ/);
  assert.match(shareResultVi(r), /không hỗ trợ chia sẻ/);
});

test("clipboard bị chặn (không HTTPS) -> hướng dẫn chép tay", async () => {
  const r = await shareLink({
    nav: {},
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    session: session(),
    url: "https://s/abc",
  });
  assert.equal(r.via, "error");
  assert.match(r.error, /chép tay/);
});

test("không có link thì không gọi sheet, không gọi clipboard", async () => {
  let called = 0;
  const r = await shareLink({
    nav: { share: async () => { called += 1; } },
    clipboard: { writeText: async () => { called += 1; } },
    session: session(),
    url: "",
  });
  assert.equal(r.via, "error");
  assert.equal(called, 0);
});

test("nhãn nút đổi theo trạng thái link", () => {
  assert.equal(shareButtonLabel(session()), "Chia sẻ");
  assert.equal(shareButtonLabel(session({ share: { url: "https://s/a" } })), "Huỷ chia sẻ");
});
