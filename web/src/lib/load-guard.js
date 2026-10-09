// Chống race cho các lượt tải dữ liệu — MỘT primitive thay 4 dạng tự chế từng
// sống ở pages/files.jsx, home.jsx, search.jsx, sessions.jsx (round 4, 09/10).
// Bốn bản cũ không ai ghim nên đã lệch nhau: files/home/sessions hủy request
// đang bay khi có lượt mới, search thì không — cả bốn còn tự trích nhau trong
// comment ("mẫu của pages/files.jsx:41-64") thay vì dùng chung một chỗ.
//
// Một semantics duy nhất:
//   - begin(kind?)  → token cho lượt này; lượt CŨ cùng kind bị hủy
//                     (AbortController) và tự thành stale. Không kind = một
//                     hàng đợi duy nhất, cho trang chỉ có một loại tải.
//   - stale(token)  → true nếu token đã cũ (begin() mới hơn cùng kind, hoặc
//                     invalidate() đã gọi) — response về trễ KHÔNG được vẽ.
//   - invalidate()  → mọi token thành stale + hủy hết request đang bay (đổi
//                     route/param, rời trang).
//
// Thuần: không import gì, không preact — node --test khoá trực tiếp. Trang cầm
// nguyên một instance bằng useRef (dựng 1 lần, sống theo đời component).
export function createLoadGuard() {
  let gen = 0;
  const seqs = new Map(); // kind -> seq hiện tại
  const inFlight = new Map(); // kind -> AbortController của lượt gần nhất

  return {
    begin(kind = "") {
      const seq = (seqs.get(kind) ?? 0) + 1;
      seqs.set(kind, seq);
      // Hủy lượt cũ cùng kind trước khi mở lượt mới — hủy controller đã kết
      // thúc là no-op, nên không cần dọn map.
      inFlight.get(kind)?.abort();
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      if (ctrl) inFlight.set(kind, ctrl);
      return { kind, seq, gen, signal: ctrl ? ctrl.signal : undefined };
    },
    stale(token) {
      if (!token) return true;
      return token.gen !== gen || seqs.get(token.kind) !== token.seq;
    },
    invalidate() {
      gen += 1;
      for (const ctrl of inFlight.values()) {
        if (ctrl) ctrl.abort();
      }
      inFlight.clear();
    },
  };
}
