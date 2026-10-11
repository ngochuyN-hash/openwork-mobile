/**
 * Khoá chạm kép theo REF — một invariant dùng chung cho mọi nút hành động.
 *
 * State (`busy`/`sending`/…) chỉ đổi ở RENDER kế tiếp, nên hai chạm liền nhau
 * (rất dễ trên màn cảm ứng, hoặc Ctrl+Enter hai lần) chạy CÙNG MỘT handler cũ:
 * cả hai đều thấy state === false và cùng đi qua — bắn hai request, xoá hai
 * lần, gửi trùng tin. Ref/guard là chốt thật: giữ ngay trong nhánh đồng bộ đầu
 * của handler, nhả ở `finally`.
 *
 * Một khoá giữ được NHIỀU chìa (keyed): hai chìa khác nhau chạy song song được
 * (ví dụ trả lời hai thẻ "Agent xin phép" khác nhau), cùng chìa thì lượt sau
 * bị chặn. Chìa mặc định "" = khoá đơn.
 */
export function createTapGuard() {
  const held = new Set();
  return {
    /** true = lượt này giữ được chìa; false = chìa đang bị giữ, lượt này dừng. */
    begin(key = "") {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    /** Nhả chìa — chỉ gọi khi begin() đã trả true (thường để trong finally). */
    end(key = "") {
      held.delete(key);
    },
    /** Nhả MỌI chìa — dọn khi rời phiên/trang, kể cả lượt đang bay. */
    clear() {
      held.clear();
    },
  };
}
