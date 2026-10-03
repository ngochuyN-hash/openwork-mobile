// Logic THUẦN cho phần "sửa OpenWork" (bộ chọn đường dẫn .exe + nhãn trạng
// thái), tách khỏi pages/settings.jsx để `node --test` chạy được không cần DOM.
//
// Vì sao tách: settings.jsx là JSX + hook + fetch, không test được bằng node
// thuần. Ba quy tắc ở đây từng là chỗ dễ sai và dễ lệch giữa các màn:
//   1. candidates đến từ HAI nguồn (bridge `openwork.candidates` kèm lúc bấm
//      "Bật OpenWork", và `wakeCandidates` tích lũy từ lỗi API) — trùng nhau
//      là chuyện thường, nếu không gộp/dedupe thì bộ chọn lặp đúng một dòng
//      cho mỗi lần bấm lại.
//   2. `found`/`running` phải là boolean THẬT. Bridge cũ không gửi `running`, và
//      `Boolean("false")` là `true` trong JS nên payload rác sẽ báo oan "đã cài"
//      / "đang chạy" — thà dán nhãn sai còn hơn. Xem `openworkFoundOf` và
//      `openworkRunningOf`, đó là nơi duy nhất chốt quy tắc này.
//
// TÌNH TRẠNG CONSUMER — cập nhật 2026-10-03 sau khi rà lại bằng grep trên
// toàn bộ `web/src` và `bridge/src`:
//   - `mergeCandidates` CÓ consumer thật, ba chỗ:
//     `pages/settings.jsx` và `app.jsx` (banner toàn cục) mỗi chỗ truyền HAI
//     nguồn vào, và `components/openwork-fix.jsx` làm sạch lần nữa trước khi vẽ.
//     Bản `new Set(...).filter(Boolean)` từng nằm ở settings.jsx đã bị thay bằng
//     hàm này.
//   - `openworkStatusLabel` CÓ consumer thật: `pages/settings.jsx` gọi để dựng
//     nhãn trạng thái, thay cho điều kiện rải trong JSX.
//   - `openworkFoundOf` / `openworkRunningOf` CÓ consumer thật: cả hai call
//     site (`settings.jsx`, `app.jsx`) và chính `openworkStatusLabel` bên dưới.
//     Trước đó guard `typeof === "boolean"` bị viết tay ở BỐN chỗ; sửa một
//     nhánh dễ quên nhánh kia.
// KHÔNG còn export chết: `openworkSourceLabel` (ánh xạ mã enum `source` của
// bridge sang tiếng Việt) đã bị XOÁ hẳn — hàng "Tìm ở đâu" không còn trong UI,
// bản copy-local trùng nội dung ở cuối settings.jsx cũng đã mất từ trước, nên
// hàm chỉ còn test phủ. Giữ một hàm mà chỉ test dùng là chỗ bẫy cho người đọc
// sau; nếu sau này cần hiển thị lại "bridge tìm exe ở đâu", ánh xạ 3 mã enum
// (`config` / `env` / `wellknown`, sinh ở bridge/src/openwork-launch.js) nằm ở
// đó và viết lại mất vài dòng.

/**
 * Gộp nhiều nguồn đường dẫn .exe thành một danh sách sạch cho bộ chọn.
 *
 * Quy tắc: TRIM rồi bỏ rỗng, bỏ trùng, GIỮ THỨ TỪ XUẤT HIỆN — đường dẫn bridge đoán
 * trước luôn ở trên, vì người dùng thường chọn đúng cái đó, đổi thứ tự là hỏng
 * dự đoán của họ. Set giữ đúng tính chất này (thêm vào không đổi vị trí mục cũ).
 *
 * CHỈ nhận phần tử kiểu string. Không ép `String(raw)`: nếu payload rác chứa
 * object, ép thành chuỗi sẽ ra dòng "[object Object]" CÓ NÚT "Dùng"
 * (settings.jsx vẽ mỗi phần tử thành một hàng có nút) — người dùng bấm vào sẽ
 * gửi chuỗi vô nghĩa lên bridge để lưu vào config.json. Bỏ hẳn thành không có
 * dòng nào để bấm, an toàn hơn là hiển thị dòng giả.
 *
 * Nguồn không phải mảng thì bỏ qua thay vì ném lỗi: field `candidates` đến từ
 * JSON của bridge qua mạng, không ai đảm bảo shape tuyệt đối — một payload lạ
 * không được làm sập màn hình Cài đặt.
 */
export function mergeCandidates(...sources) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const raw of source) {
      if (typeof raw !== "string") continue; // null / object / số — xem JSDoc
      // So VÀ đẩy bằng bản ĐÃ TRIM, không phải `raw` nguyên bản. Nếu dedupe
      // trên `raw` còn đẩy `raw` thì mergeCandidates(["  C:\\a.exe ", "C:\\a.exe"])
      // ra HAI hàng "Dùng" trông y hệt nhau, chỉ khác khoảng trắng — đúng cái
      // "dòng giả" mà hàm này sinh ra để chặn. Nguồn dễ dính nhất là
      // `wakeCandidates` (cả settings.jsx lẫn app.jsx đều đẩy nguyên
      // `e.candidates` từ lỗi API, không trim); nguồn từ bridge thì đã tự trim
      // sẵn ở bridge/src/openwork-launch.js:20,23. Trim ở đây vô hại vì
      // `choosePath`/`chooseExePath` vốn đã `String(path ?? "").trim()` trước
      // khi gửi, nên giá trị trim ở đây không đổi điều gì người dùng thấy.
      const path = raw.trim();
      if (path === "") continue; // rỗng hoặc toàn khoảng trắng
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Bridge có đã thấy OpenWork.exe chưa?
 *
 * NGUYÊN TẮC: chỉ tin `info.found` khi nó là boolean THẬT; không phải thì lùi về
 * `legacyFlag`. KHÔNG dùng `Boolean(info.found)`: mọi chuỗi đều truthy trong JS,
 * kể cả chuỗi "false", nên payload rác sẽ ra `true` và UI hiện nguyên mảng
 * "đã cài" cho một exe không tồn tại. Ước lượng thấp — `describeOpenWorkInstall`
 * chỉ trả boolean thật — nhưng đây đúng là loại lỗi file này sinh ra để chặn.
 *
 * `legacyFlag` là boolean CŨ `state.openworkExeFound` mà bridge đời trước gửi
 * (bridge/src/index.js:400), dùng khi thiếu object `openwork`.
 *
 * Trước đó quy tắc này viết tay ở settings.jsx, app.jsx và trong chính
 * `openworkStatusLabel` bên dưới — ba bản, sửa một chỗ dễ quên hai chỗ kia.
 *
 * @param {{found?: unknown} | null | undefined} info
 * @param {unknown} [legacyFlag]
 */
export function openworkFoundOf(info, legacyFlag) {
  return typeof info?.found === "boolean" ? info.found : Boolean(legacyFlag);
}

/**
 * App có đang mở không? Cùng nguyên tắc boolean nghiêm ngặt như `openworkFoundOf`.
 *
 * `legacyFlag` ở đây là `Boolean(state?.server)` — "server sống nghĩa là app
 * đang mở", dùng cho bridge cũ không gửi field `running`.
 *
 * @param {{running?: unknown} | null | undefined} info
 * @param {unknown} [legacyFlag]
 */
export function openworkRunningOf(info, legacyFlag) {
  return typeof info?.running === "boolean" ? info.running : Boolean(legacyFlag);
}

/**
 * Nhãn trạng thái app ("đang chạy" / "đã cài, chưa mở") cho màn Cài đặt.
 *
 * CONTRACT — đọc trước khi đổi chỗ gọi:
 *
 * - Trả CHUỖI RỖNG khi chưa chắc là đã cài. Chuỗi rỗng KHÔNG phải "ẩn đi được":
 *   nếu chỗ gọi quyết định hiện khối trạng thái bằng `openworkFound` tính từ một
 *   nguồn khác, còn nhãn lại lấy từ `info` rỗng, hàng trạng thái sẽ trống.
 *   Phải truyền `foundFallback` như dưới.
 * - `opts.foundFallback` (boolean, tuỳ chọn): tín hiệu "đã thấy exe" từ nguồn thứ
 *   hai — `state.openworkExeFound`, boolean CŨ mà bridge đời trước gửi
 *   (bridge/src/index.js:400). Dùng khi `info.found` KHÔNG phải boolean — gồm cả
 *   lúc `info` không có (thiếu object `openwork`). Còn khi `info.found` là boolean
 *   thì nó là nguồn chính, không để fallback ghi đè.
 * - `opts.runningFallback` (boolean, tuỳ chọn): tín hiệu "app đang mở" từ nguồn
 *   thứ hai — `Boolean(state?.server)` ("server sống nghĩa là app đang mở").
 *   CHỈ dùng khi `info.running` KHÔNG phải boolean.
 * - MẶC ĐỊNH khi thiếu cả hai fallback: coi như chưa cài / chưa chạy. Vì sao an
 *   toàn: màn Cài đặt dùng cùng một cờ `running` cho CẢ nhãn LẪN điều kiện hiện
 *   nút "Mở OpenWork". Nếu bridge già gửi `running` kiểu khác (chuỗi/số), hoặc
 *   ai đó bỏ qua fallback, nhãn sẽ đổi từ "đang chạy" sang "đã cài, chưa mở" VÀ
 *   bật thêm một hành động sai — tệ hơn việc thiếu một dòng chữ. Bridge hiện
 *   tại luôn gửi boolean thật (`running: isProcessAlive(owner)`, bridge/src/index.js)
 *   nên lỗi này chưa nổ; đó là lý do contract phải viết ra, không phải lý do để
 *   im lặng.
 *
 * @param {{found?: boolean, running?: unknown} | null | undefined} info
 * @param {{foundFallback?: boolean, runningFallback?: boolean}} [opts]
 */
export function openworkStatusLabel(info, opts = {}) {
  // `opts?.` chứ không phải `opts.`: tham số mặc định `= {}` chỉ che khi caller
  // BỎ HẲN tham số, còn truyền `null` thì vẫn null và `opts.foundFallback` ném
  // TypeError. Cùng nguyên tắc với mergeCandidates: payload lạ không được làm
  // sập màn hình Cài đặt.
  const found = openworkFoundOf(info, opts?.foundFallback);
  if (!found) return "";
  return openworkRunningOf(info, opts?.runningFallback)
    ? "đang chạy"
    : "đã cài, chưa mở";
}