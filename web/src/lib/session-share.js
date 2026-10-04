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
      ? { ok: false, url, error: "The computer still has the share link; it could not be revoked." }
      : { ok: true, url: "", error: "" };
  }
  if (!url) {
    return {
      ok: false,
      url: "",
      error: "The computer did not return a share link for this session. Try turning sharing off and on again.",
    };
  }
  return { ok: true, url, error: "" };
}

/** Lỗi của endpoint share -> một câu tiếng Việt đọc được (không lộ HTTP thô). */
export function shareError(error) {
  const message = String(error?.message ?? error ?? "");
  if (message === "UNPAIRED") {
    return "Computer not paired yet — open the app on your computer to pair, then try again.";
  }
  const status = Number(error?.status ?? 0);
  if (message === "AbortError" || error?.name === "AbortError") {
    return "You have revoked sharing.";
  }
  if (status === 400) return "The computer rejected the share request for this session.";
  if (status === 401) return "Connection key expired — pair your computer again and retry.";
  if (status === 403) return "This key is read-only; it cannot share sessions.";
  if (status === 404) return "Session not found on the computer (it may have been deleted).";
  if (status >= 500) return "The computer is having errors — try again in a few minutes.";
  // Lỗi mạng không có status: fetch reject. Câu chung, không đoán bừa.
  if (!message || message === "Failed to fetch" || /network|load failed/i.test(message)) {
    return "Could not reach your computer — check your network and try again.";
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
  const data = { title: title || "Session on OpenWork", url: link };
  if (title) data.text = `View session "${title}" on OpenWork:`;
  return data;
}

/**
 * Chuẩn hoá một lần bấm "Chia sẻ": có `navigator.share` thì mở sheet của máy,
 * không có thì chép link vào clipboard (bỏ hẳn việc tự mở tab — người dùng
 * chỉ muốn lấy link để dán). Ném lỗi có status thì lỗi sẽ qua `shareError`.
 *
 * Trả { via, url, error } với via ∈ share | copy | cancelled | unsupported |
 * error. `share` bị lỗi KHÔNG phải huỷ (khác AbortError) thì rơi tiếp xuống
 * clipboard — sheet hỏng vẫn lấy được link.
 */
export async function shareLink({ nav, clipboard, session, url } = {}) {
  const link = String(url ?? "").trim();
  if (!link) return { via: "error", url: "", error: "No link to share yet." };
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
    return { via: "unsupported", url: link, error: "This device does not support sharing, and the link could not be copied." };
  }
  try {
    await clipboard.writeText(link);
    return { via: "copy", url: link, error: "" };
  } catch {
    return { via: "error", url: link, error: "Could not copy the link — tap the link and copy it manually." };
  }
}

/** Câu báo lại cho người dùng sau khi `shareLink` chạy (rỗng = không cần báo). */
export function shareResult(result) {
  switch (result?.via) {
    case "share":
      return "";
    case "copy":
      return "This device has no share sheet — the link was copied, paste it wherever you like.";
    case "cancelled":
      return "";
    default:
      return String(result?.error ?? "") || "Sharing failed.";
  }
}

/** Nhãn nút: đang bật link thì đổi sang huỷ chia sẻ. */
export function shareButtonLabel(session) {
  return isShared(session) ? "Revoke share" : "Share";
}
