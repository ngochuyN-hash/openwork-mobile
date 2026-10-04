// Logic thuần cho CUỘN MÀN CHAT — tách khỏi chat.jsx để test được, đúng khuôn
// lib/chat-stream.js và lib/session-ops.js.
//
// Ba chỗ dễ sai, đã đối chiếng từng dòng:
//
//  1. "Có bám đáy không" phải đo TRƯỚC khi nội dung mới được render, không đo
//     sau. Code cũ đo `scrollHeight - innerHeight - scrollY` trong effect chạy
//     SAU render: transcript vừa nạp xong thì scrollHeight đã dài, scrollY
//     vẫn 0, gap thành hàng nghìn px → `gap > 260` → không cuộn. Hệ quả là mở
//     phiên dài là thấy TIN CŨ NHẤT, phải tự vuốt xuống.
//
//  2. Lần đầu vào phiên phải cuộn TỚI ĐÁY bất kể dài bao nhiêu (`forced`), và
//     cuộn tức thì chứ không smooth — transcript vài nghìn px mà smooth là người
//     dùng phải đợi cả giây mới tới đáy.
//
//  3. Số "tin mới" chỉ đếm TIN nối vào ĐUÔI, không đếm delta part: lúc stream,
//     cùng một tin assistant bị đổi hàng trăm lần, đếm part sẽ nhảy số lung
//     tung trên nút. Cũng không đếm lại một tin chỉ bị ĐỔI ID: tin optimistic
//     `local-…` được engine thay bằng `msg_…` ở đúng chỗ đó — đó là CÙNG một
//     tin, đếm hai lần là báo sai.
//
// Trang cuộn trên WINDOW (màn chat không có khung cuộn riêng) — mọi số đo ở đây
// lấy từ document/window, đúng như chat.jsx đang làm.

// Ngưỡng coi là "đang ở đáy". Giữ bằng đúng ngưỡng cũ (260px) để không đổi cảm
// giác bám đáy sẵn có: người dùng lướt lên đọc lịch sử một chút rồi tự về vẫn
// được bám tiếp.
export const BOTTOM_FOLLOW_PX = 260;

/** Khoảng cách từ mép dưới viewport tới đáy trang, không bao giờ âm. */
export function distanceFromBottom({ scrollHeight, viewportHeight, scrollY }) {
  const h = Number(scrollHeight) || 0;
  const vh = Number(viewportHeight) || 0;
  const y = Number(scrollY) || 0;
  return Math.max(0, h - vh - y);
}

/**
 * Đang bám đáy hay không (dùng cho cả quyết định cuộn lẫn hiện nút).
 * `gap` là số ĐÃ đo bằng `distanceFromBottom` — số rác thì coi như ở đáy, vì
 * "không đo được" không được phép biến thành "kéo người dùng xuống đáy".
 */
export function isAtBottom(gap, threshold = BOTTOM_FOLLOW_PX) {
  const n = Number(gap);
  return (Number.isFinite(n) ? Math.max(0, n) : 0) <= (Number(threshold) || 0);
}

/**
 * Có cuộn không, cuộn kiểu nào.
 *
 * @param forced   lần đầu vào phiên (transcript vừa nạp xong) — LUÔN "instant",
 *                 không phụ thuộc người dùng đang ở đâu. Đây là fix của bug
 *                 "mở phiên dài thấy tin cũ nhất".
 * @param atBottom vị trí thật của người dùng (đo ở nhịp scroll trước, và giữ
 *                 nguyên "đang bám đáy" suốt lúc cuộn bằng lệnh của app).
 * @returns "instant" | "smooth" | "hold"
 */
export function scrollPlan({ forced = false, atBottom = true } = {}) {
  if (forced) return "instant";
  return atBottom ? "smooth" : "hold";
}

/** Id của 1 message (shape engine `{info:{id}}` hoặc phẳng). */
function idOf(message) {
  return String(message?.info?.id ?? message?.id ?? "");
}

/**
 * Số TIN MỚI nối vào ĐUÔI transcript kể từ lần nhìn trước.
 *
 * Chỉ đếm phần sau tin cuối cùng đã từng thấy — nên:
 *  - một tin chỉ đổi id (optimistic `local-…` → `msg_…`) KHÔNG bị đếm lại;
 *  - tin chèn ở đầu danh sách không tính vào "tin mới";
 *  - cùng một tin assistant bị đổi part khi stream KHÔNG nhảy số.
 * Danh sách rỗng trước (mới vào phiên) thì mọi tin đều là mới.
 */
export function newMessagesSince(prevList, nextList) {
  const prev = Array.isArray(prevList) ? prevList : [];
  const next = Array.isArray(nextList) ? nextList : [];
  if (!next.length) return 0;

  // Danh sách trước rỗng (mới vào phiên): mọi tin có id đều là mới. Vẫn khử
  // trùng — id lặp là tin rác, đếm hai lần là báo sai.
  if (!prev.length) {
    const ids = new Set();
    for (const m of next) {
      const id = idOf(m);
      if (id) ids.add(id);
    }
    return ids.size;
  }

  const seen = new Set(prev.map(idOf).filter(Boolean));
  // Mốc: tin ĐÃ THẤY nằm xa nhất sang phải trong danh sách mới. Chỉ đếm những
  // tin nằm SAU mốc — đó mới là "mới nối vào đuôi".
  // Vì sao không dùng luôn tin cuối của `prev`: tin cuối có thể vừa bị xoá, hoàn
  // tác, hoặc đổi id (tin optimistic `local-…` được engine thay bằng `msg_…`),
  // lúc đó sẽ không tìm thấy và tệ hơn là đếm cả transcript.
  let anchor = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const id = idOf(next[i]);
    if (id && seen.has(id)) {
      anchor = i;
      break;
    }
  }
  // Không còn tin nào quen (list bị thay hẳn) → không có mốc, không đoán: 0.
  if (anchor < 0) return 0;

  let n = 0;
  for (let i = anchor + 1; i < next.length; i += 1) {
    const id = idOf(next[i]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    n += 1;
  }
  return n;
}

/** Chữ trên nút nhảy về đáy. */
export function jumpLabelVi(count) {
  const n = Math.max(0, Number(count) || 0);
  if (!n) return "Tin mới nhất";
  return `${n} tin mới`;
}

/** Nút có hiện không: chỉ khi đang LỊCH SỬ và đã có tin để cuộn tới. */
export function shouldShowJump({ atBottom, visibleCount }) {
  return !atBottom && (Number(visibleCount) || 0) > 0;
}

/**
 * Còn được coi là "đang cuộn bằng lệnh của app" không?
 *
 * Đây là chốt chặn BUG LỚN NHẤT của cả màn: nếu không hỏi, chính lệnh cuộn của
 * app được đọc thành người dùng đang lướt lên. Một smooth scroll còn đang chạy
 * thì khoảng cách tới đáy tạm thời lớn, `measure` kết luận "người dùng đọc
 * lịch sử", và nhịp stream kế tiếp rơi vào nhánh hold — tự cuộn chết giữa
 * chừng, đúng cái lỗi ta sinh ra để chữa.
 *
 * Thả quyền khi: đã tới nơi (`gap <= ARRIVED`), hoặc người dùng KÉO NGƯỢC lên
 * (`movedUp`) — lúc đó là họ đang đọc, app thôi giành.
 */
export function keepsAutoScroll({ autoScroll, gap, movedUp, arrivedAt = ARRIVED_PX }) {
  if (!autoScroll) return false;
  const g = Number(gap);
  return !(movedUp || (Number.isFinite(g) ? g <= arrivedAt : false));
}

/** Chạm đáy (px) — dưới ngưỡng này coi như đã tới nơi. */
export const ARRIVED_PX = 4;

/**
 * Người dùng đang bỏ bám đáy không?
 *
 * Vuốt lên là động cửa "cho tôi đọc lịch sử", nên PHẢI rời vùng bám ngay, không
 * chờ vượt ngưỡng 260px. Nếu không, khi agent đang stream (mỗi nhịp flush đều
 * ra một lệnh cuộn) thì người dùng phải vuốt quá 260px trong một nhịp đo mới
 * thoát được — tức là gần như không lướt lên đọc được, và nút "về tin mới nhất"
 * mất hết ý nghĩa đúng lúc cần nhất.
 */
export function leftBottomBy({ autoScroll, gap, movedUp, threshold = BOTTOM_FOLLOW_PX }) {
  if (autoScroll) return false; // đang cuộn bằng lệnh của app
  if (movedUp) return true;
  return !isAtBottom(gap, threshold);
}