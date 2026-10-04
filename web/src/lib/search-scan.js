// Logic THUẦN cho trạng thái quét của ô Tìm phiên (pages/search.jsx) — tách ra
// để `node --test` chạy được không cần DOM.
//
// Vì sao tách: `scanning` / `scanned` / `debounced` / `results.length` được
// đọc ở bốn chỗ khác nhau (dòng hint + hai nhánh <Empty> + điều kiện chọn nhánh)
// và BỐN điều kiện đó phải nhất quán với nhau. Bản cũ rải trong JSX nên dễ lệch:
// effect quét nảy ra sớm (`return` khi không còn gì cần quét, hoặc bị huỷ vì
// người dùng gõ tiếp) mà KHÔNG setScanning(0) -> `scanning` đứng ở số cũ vĩnh
// viễn. Hậu quả nhìn thấy được: dòng hint kẹt "đang quét 12 phiên" mãi, và
// nhánh "Không tìm thấy …" (điều kiện `!scanning`) không bao giờ hiện — người
// dùng bị treo ở "Đang dò tiếp…" dù đã quét xong từ lâu.

/**
 * Trạng thái hiển thị của trang Tìm phiên, gói trong MỘT hàm để dòng hint và
 * nhánh <Empty> không thể lệch nhau.
 *
 * @param {object} p
 * @param {string} p.debounced     từ khoá sau debounce (rỗng = chưa gõ)
 * @param {number} p.resultCount   số kết quả lọc được
 * @param {number} p.scanning      số phiên đang tải transcript
 * @param {number} p.scanned       số phiên đã quét xong
 * @param {number} p.totalSessions tổng số phiên trong phạm vi tìm
 * @returns {{phase: "idle"|"scanning"|"none"|"empty", hint: string, hintText: string}}
 *   `phase` quyết định <Empty> nào vẽ; `hintText` là dòng chữ nhỏ trên đầu.
 */
export function scanState({ debounced, resultCount = 0, scanning = 0, scanned = 0, totalSessions = 0 } = {}) {
  const n = Math.max(0, Number(resultCount) || 0);
  const busy = Math.max(0, Number(scanning) || 0);
  const done = Math.max(0, Number(scanned) || 0);
  const total = Math.max(0, Number(totalSessions) || 0);
  // TRIM: `debounced` đã qua normalizeQuery ở search.jsx, nhưng hàm này phải
  // tự đúng với đầu vào của nó — chỉ toàn khoảng trắng là "chưa gõ", không
  // phải một từ khoá không khớp gì (sẽ đi thẳng tới nhánh "không tìm thấy").
  const q = String(debounced ?? "").trim();

  // Chưa gõ gì: không có kết quả nào để hiện, dùng `searchSessions` vẫn trả về
  // danh sách (xem JSDoc ở session-search.js) — phải chặn ở đây.
  if (!q) {
    return {
      phase: "idle",
      hint: total ? `${total} sessions to search` : "…",
      hintText: "",
    };
  }

  const tail = busy ? ` · scanning ${busy} sessions` : done ? ` · scanned content of ${done} sessions` : "";
  const hint = `${n} results${tail}`;

  if (n > 0) return { phase: "none", hint, hintText: "" };
  // Còn đang quét -> chưa kết luận được, đừng nói "không tìm thấy".
  if (busy > 0) {
    return {
      phase: "scanning",
      hint,
      hintText: "Still scanning the conversation content of recent sessions — please wait a moment.",
    };
  }
  return {
    phase: "empty",
    hint,
    // Nói thẳng đã quét tới đâu: im lặng ra danh sách "đầy đủ" nhưng thiếu là
    // thông tin sai. `scanPlan` chỉ quét SCAN_LIMIT phiên mỗi lượt.
    hintText:
      done < total
        ? `Scanned content of ${done}/${total} sessions — older sessions were not scanned. Try adding more keywords or fewer words.`
        : "Try fewer keywords, or check the spelling.",
  };
}

/**
 * Ghép kết quả quét mới vào cache nội dung, KHÔNG giữ mục rác.
 *
 * `contents` là cache transcript đã tải (search.jsx giữ nó để gõ tiếp không
 * phải tải lại). Bản cũ spread toàn bộ object nên nếu `contents` từng bị set
 * `{}` (đổi workspace) trong lúc một lượt quét cũ còn bay, mục từ workspace
 * trước sống lại và được ghép vào danh sách workspace mới -> kết quả khớp nhầm
 * session của máy khác. Ở đây chỉ nhận id đã BIẾT là thuộc phạm vi hiện tại.
 *
 * @param {Record<string, string>} current
 * @param {{sid: string, text: string}[]} fetched
 * @param {Set<string>} allowed  id được phép giữ (id của workspace đang tìm)
 */
export function mergeContents(current, fetched, allowed) {
  const base = current && typeof current === "object" ? current : {};
  const keep = allowed instanceof Set ? allowed : null;
  const next = {};
  for (const [k, v] of Object.entries(base)) {
    if (keep && !keep.has(k)) continue; // thuộc workspace trước -> bỏ
    next[k] = v;
  }
  for (const f of Array.isArray(fetched) ? fetched : []) {
    if (!f || typeof f.sid !== "string") continue;
    if (keep && !keep.has(f.sid)) continue;
    next[f.sid] = String(f.text ?? "");
  }
  return next;
}
