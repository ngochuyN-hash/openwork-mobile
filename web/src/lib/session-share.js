// Logic THUẦN cho nút "Chia sẻ phiên" — tách khỏi pages/*.jsx để `node --test`
// chạy được không cần DOM, đúng cách dự án làm với lib/session-ops.js.
//
// Hợp đồng endpoint (đọc từ type thật của @opencode-ai/sdk@1.18.25, không suy đoán):
//   POST   /session/{id}/share  → 200: Session   (share() trong dist/gen/sdk.gen.js:318-324)
//   DELETE /session/{id}/share  → 200: Session   (unshare() cùng file :309-316)
// Body KHÔNG có gì; thư mục đi qua query `?directory=` (SessionShareData:
// `body?: never`, `query?: { directory?: string }`). Link nằm ở `Session.share.url`
// — kiểu `share?: { url: string }`, KHÔNG phải field phẳng (types.gen.d.ts:476-478).
// Lỗi khai báo: 400 BadRequestError, 404 NotFoundError.
// Qua bridge: `POST /api/ow/workspace/{ws}/opencode/session/{sid}/share`. Chạy thật
// isProxyPathAllowed(path) → true và isMethodAllowed('POST'/'DELETE') → true, nên
// KHÔNG cần mở thêm backend.
//
// Ba chỗ dễ sai, chốt ở đây để UI chỉ việc gọi:
//   1. `share` là OBJECT `{url}`, không phải chuỗi. Ai đọc `session.share` như
//      string sẽ share ra "[object Object]".
//   2. 200 KHÔNG chắc là đã có link — phiên chưa bật share thì `share` vắng mặt.
//      Phải kiểm link thật rồi mới báo thành công, không báo oan.
//   3. `navigator.share` chỉ có trên HTTPS/máy có hỗ trợ, và bấm Hủy trên sheet
//      là AbortError — KHÔNG phải lỗi, đừng hiện banner đỏ.

/** Link chia sẻ đã bật, hoặc "" (chưa bật / phiên không có `share`). */
export function shareUrlOf(session) {
  const url = session?.share?.url;
  return typeof url === "string" ? url.trim() : "";
}

export function isShared(session) {
  return shareUrlOf(session) !== "";
}

/**
 * Bóc phản hồi của POST/DELETE /session/:id/share thành view model.
 * Engine trả nguyên Session; `ow()` trong api.js đã unwrap `.data` nhưng vài
 * đường (bridge cũ, engine v2) vẫn bọc, nên ở đây bóc thêm một lần cho chắc.
 *
 * Trả { ok, url, error } — `ok` false kèm lời tiếng Việt để UI hiện thẳng.
 */
export function parseShareResponse(payload, { unshare = false } = {}) {
  const session = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  const url = shareUrlOf(session);
  if (unshare) {
    // DELETE trả Session mà `share` đã bị gỡ — thành công khi không còn link.
    return url
      ? { ok: false, url, error: "Máy tính vẫn còn link chia sẻ, chưa huỷ được." }
      : { ok: true, url: "", error: "" };
  }
  if (!url) {
    return {
      ok: false,
      url: "",
      error: "Máy tính không trả về link chia sẻ cho phiên này. Thử tắt rồi bật lại chia sẻ.",
    };
  }
  return { ok: true, url, error: "" };
}

/** Lỗi của endpoint share -> một câu tiếng Việt đọc được (không lộ HTTP thô). */
export function shareErrorVi(error) {
  const message = String(error?.message ?? error ?? "");
  if (message === "UNPAIRED") {
    return "Chưa ghép máy tính — mở App trên máy anh để ghép rồi thử lại.";
  }
  const status = Number(error?.status ?? 0);
  if (message === "AbortError" || error?.name === "AbortError") {
    return "Bạn đã huỷ chia sẻ.";
  }
  if (status === 400) return "Máy tính từ chối yêu cầu chia sẻ phiên này.";
  if (status === 401) return "Chìa kết nối hết hạn — ghép lại máy tính rồi thử.";
  if (status === 403) return "Chìa này chỉ xem được, không chia sẻ được phiên.";
  if (status === 404) return "Không tìm thấy phiên này trên máy tính (có thể đã bị xoá).";
  if (status >= 500) return "Máy tính đang lỗi, thử lại sau ít phút.";
  // Lỗi mạng không có status: fetch reject. Câu chung, không đoán bừa.
  if (!message || message === "Failed to fetch" || /network|load failed/i.test(message)) {
    return "Không nối được tới máy tính — kiểm tra mạng rồi thử lại.";
  }
  return message;
}

/** Máy này có Web Share API không (truyền `nav` để test được). */
export function canWebShare(nav) {
  return typeof nav?.share === "function";
}

/** Dữ liệu đưa cho sheet chia sẻ: tiêu đề phiên + link. */
export function buildShareData(session, url) {
  const title = String(session?.title ?? "").trim();
  const link = String(url ?? "").trim();
  const data = { title: title || "Phiên trên OpenWork", url: link };
  if (title) data.text = `Xem phiên "${title}" trên OpenWork:`;
  return data;
}

/**
 * Chuẩn hoá một lần bấm "Chia sẻ": có `navigator.share` thì mở sheet của máy,
 * không có thì chép link vào clipboard (bỏ hẳn việc tự mở tab — người dùng
 * chỉ muốn lấy link để dán). Ném lỗi có status thì lỗi sẽ qua `shareErrorVi`.
 *
 * Trả { via, url, error } với via ∈ share | copy | cancelled | unsupported |
 * error. `share` bị lỗi KHÔNG phải huỷ (khác AbortError) thì rơi tiếp xuống
 * clipboard — sheet hỏng vẫn lấy được link.
 */
export async function shareLink({ nav, clipboard, session, url } = {}) {
  const link = String(url ?? "").trim();
  if (!link) return { via: "error", url: "", error: "Chưa có link để chia sẻ." };
  const data = buildShareData(session, link);
  if (canWebShare(nav)) {
    try {
      await nav.share(data);
      return { via: "share", url: link, error: "" };
    } catch (e) {
      if (e?.name === "AbortError") return { via: "cancelled", url: link, error: "" };
    }
  }
  if (typeof clipboard?.writeText !== "function") {
    return { via: "unsupported", url: link, error: "Máy này không hỗ trợ chia sẻ, và không chép được link." };
  }
  try {
    await clipboard.writeText(link);
    return { via: "copy", url: link, error: "" };
  } catch {
    return { via: "error", url: link, error: "Không chép được link — bấm vào link rồi chép tay." };
  }
}

/** Câu báo lại cho người dùng sau khi `shareLink` chạy (rỗng = không cần báo). */
export function shareResultVi(result) {
  switch (result?.via) {
    case "share":
      return "";
    case "copy":
      return "Máy này không có sheet chia sẻ — đã chép link, bạn dán thoải mái.";
    case "cancelled":
      return "";
    default:
      return String(result?.error ?? "") || "Chia sẻ không được.";
  }
}

/** Nhãn nút: đang bật link thì đổi sang huỷ chia sẻ. */
export function shareButtonLabel(session) {
  return isShared(session) ? "Huỷ chia sẻ" : "Chia sẻ";
}
