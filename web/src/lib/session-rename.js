// Logic THUẦN cho việc ĐỔI TÊN phiên (session), tách khỏi UI để `node --test`
// chạy được không cần DOM — cùng cách lib/session-ops.js và lib/openwork-fix.js
// đang làm cho chat.jsx và settings.jsx.
//
// Vì sao cần một lib riêng cho một chức năng nhỏ: nơi dễ sai KHÔNG phải lệnh
// gửi, mà là cái tên rác đi từ ô nhập tới engine. Ba chỗ dễ sai, mỗi chỗ đã
// từng thành bug ở màn khác của app này:
//
//   1. RỖNG. `title: ""` là yêu cầu HỢP LỆ về mặt HTTP — engine nhận và phiên
//      thành "Không tiêu đề" (đúng cái fallback đang dùng ở home.jsx và
//      sessions.jsx). Người dùng tưởng đã đặt tên xong, mở lại thì mất.
//   2. QUÁ DÀI. Tiêu đề phiên hiện trong thẻ `<h3>` (sessions.jsx:122,
//      home.jsx:127); một chuỗi dài làm cả danh sách méo. Trần ở đây chốt
//      MỘT con số để mọi nơi dùng chung, không phải mỗi chỗ tự chặn.
//   3. NHIỀU DÒNG / KHOẢNG TRẮNG thừa. Ô nhập trên điện thoại hay dính ký tự
//      Enter của bàn phím → title chứa "\n". Engine vẫn nhận, UI vẽ một dòng
//      vỡ xuống mấy dòng và giữ khoảng trắng lơ lửng ở cuối (giống đúng lỗi mà
//      `mergeCandidates` trong lib/openwork-fix.js phải dọn cho đường dẫn .exe).
//
// HỢP ĐỒNG VỚI ENGINE — endpoint đã xác minh, xem ghi chú cuối file:
//   PATCH /workspace/{id}/opencode/session/{sessionId}?directory={dir}
//   body: { "title": "<tên mới>" }
// Hàm ở đây CHỈ lo phần "tên hợp lệ"; dựng URL + gửi body là việc của
// api.js (owRenameSession). Ở đây KHÔNG có fetch, KHÔNG có JSX.
//
// TRẠNG THÁI CONSUMER — cập nhật 2026-10-04: ĐÃ NỐI.
//   - api.js có `owRenameSession`; chat.jsx có nút "Đổi tên" (RenameSheet).
//   - sessions.jsx/home.jsx hiển thị tên qua `sessionTitleOf`.
//   - Khối "GHÉP LẠI" cuối file đã thực hiện xong, còn lại để tham khảo.

/**
 * Trần độ dài tên phiên, đếm theo KÍ TỰ (code point) chứ không theo đơn vị
 * UTF-16 — tên tiếng Việt có dấu nằm gọn trong BMP nên không đổi gì, nhưng
 * emoji trong tên thì đếm 2 nếu đếm `length` (😀 = 2 đơn vị), và cắt bằng
 * `slice` thì dễ cắt đôi một ký tự, để lại "😀" hỏng thành ��.
 *
 * Con số 120 là do BẢN THÂN file này chốt, không phải trần từ engine: engine
 * opencode không công bố giới hạn cho `title` (xem mục "CHƯA XÁC MINH"). 120
 * làm theo trần tên nhóm của chính OpenWork — apps/server/src/routes/
 * session-groups.ts:73-88 cắt `label` ở 120 — để hai loại "tên" trong app có
 * cùng một trần và ô nhập cho cả hai cùng `maxlength`. Nếu sau này đọc được
 * `/doc` của engine và thấy trần khác, sửa MỘT dòng constant này, toàn bộ
 * nơi dùng đi theo.
 */
export const MAX_SESSION_TITLE_LENGTH = 120;

/** Nhãn hiện khi phiên chưa có tên (trùng với home.jsx:127 + sessions.jsx:122). */
export const UNTITLED_SESSION_LABEL = "Không tiêu đề";

/** Lỗi hiển thị được cho người dùng (tiếng Việt, dùng thẳng trong Banner). */
export const RENAME_ERRORS = {
  empty: "Tên phiên không được để trống.",
  tooLong: `Tên phiên dài tối đa ${MAX_SESSION_TITLE_LENGTH} ký tự.`,
  notText: "Tên phải là chữ, không phải số hay danh sách.",
};

/**
 * Cắt chuỗi theo code point, KHÔNG cắt đôi ký tự. Dùng vòng lặp thay vì
 * `[...str].slice()` vì title vào từ ô nhập là chuỗi thường, nhưng payload lạ /
 * dán nhầm có thể dài hàng trăm nghìn ký tự — đệ quy kiểu spread sẽ vỡ stack.
 */
function clipByCodePoint(value, max) {
  let end = 0;
  let count = 0;
  while (end < value.length && count < max) {
    const cp = value.codePointAt(end);
    end += cp > 0xffff ? 2 : 1;
    count += 1;
  }
  return value.slice(0, end);
}

/**
 * Gộp mọi cụm khoảng trắng (space, tab, xuống dòng, không gian mỏng) thành MỘT
 * space rồi trim hai đầu. Giữ lại khoảng trắng bên trong câu ("sửa bug login")
 * vì đó là ý người dùng; chỉ dẹp khoảng trắng THỪA và ký tự điều khiển mà bàn
 * phím dính vào.
 */
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

/** Hợp đồng trả về: thành công `{ok:true,title}`, hỏng `{ok:false,error}`. */
function ok(title) {
  return { ok: true, title };
}

function fail(error) {
  return { ok: false, error };
}

/**
 * Chuẩn hoá tên phiên người dùng gõ. KHÔNG tự cắt quá trần — trả lỗi để UI báo
 * và giữ nguyên nội dung ô nhập. Cắt âm thầm là loại "làm hộ rồi giấu" mà
 * lib/openwork-fix.js cảnh báo: người dùng thấy tên đã lưu nhưng không phải
 * tên mình gõ, thà không có tên còn hơn tên sai. Ai muốn xem trước bản cắt thì
 * dùng `clipSessionTitle` ở dưới.
 *
 * @param {unknown} raw giá trị ô nhập (string) hoặc title engine trả về
 * @param {{max?: number}} [opts] trần độ dài, mặc định MAX_SESSION_TITLE_LENGTH
 * @returns {{ok: true, title: string} | {ok: false, error: string}}
 */
export function normalizeSessionTitle(raw, opts = {}) {
  const max = Number.isInteger(opts?.max) && opts.max > 0 ? opts.max : MAX_SESSION_TITLE_LENGTH;
  // Số được ép chuỗi được (id hay nhãn lưu bằng số từ đâu đó) — nhưng object và
  // mảng thì KHÔNG: `String({})` ra "[object Object]", đẩy lên đây là dán
  // thêm một dòng rác vào danh sách phiên, đúng cái lỗi `mergeCandidates`
  // đã chặn cho đường dẫn .exe.
  const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof text !== "string" || !text.trim()) return fail(RENAME_ERRORS.empty);
  const title = oneLine(text);
  if (!title) return fail(RENAME_ERRORS.empty);
  if ([...title].length > max) return fail(RENAME_ERRORS.tooLong);
  return ok(title);
}

/**
 * Bản cắt dùng để HIỂN THỊ trước (xem trước, hoặc gợi ý nút lưu sẽ lưu gì),
 * không dùng để quyết định có cho lưu hay không. Cắt rồi dẹp khoảng trắng lần
 * nữa — nếu không, "sửa bug   " bị cắt đúng giữa cụm khoảng trắng sẽ để lại
 * một đuôi " " mà title nào cũng có thể bị đuôi, khó phát hiện khi nhìn.
 *
 * @param {unknown} raw
 * @param {{max?: number}} [opts]
 * @returns {string} chuỗi rỗng nếu không dùng được
 */
export function clipSessionTitle(raw, opts = {}) {
  const max = Number.isInteger(opts?.max) && opts.max > 0 ? opts.max : MAX_SESSION_TITLE_LENGTH;
  const text = typeof raw === "string" ? raw : "";
  const title = oneLine(text);
  if (!title) return "";
  return oneLine(clipByCodePoint(title, max));
}

/**
 * Tên hiển thị của 1 phiên, đã có sẵn nhãn thay thế. Gom ra đây vì hiện có ĐÚNG
 * hai chỗ lặp `s.title || "Không tiêu đề"` (home.jsx:127, sessions.jsx:122):
 * sửa nhãn một lần ở đây thay vì sửa hai bản — và sau này khi phiên có tiêu đề
 * rỗng tạm thời (đang gõ mà chưa lưu) cũng chỉ có một chỗ quyết định hiện gì.
 *
 * @param {{title?: unknown} | null | undefined} session
 * @returns {string}
 */
export function sessionTitleOf(session) {
  const raw = session?.title;
  const title = oneLine(typeof raw === "string" ? raw : "");
  return title || UNTITLED_SESSION_LABEL;
}

/**
 * Tên mới có khác tên cũ không — dùng để KHÔNG gửi PATCH thừa. So trên cả hai
 * bản đã chuẩn hoá, vì kiểu gõ tay hay sinh ra khác biệt vô nghĩa: "sửa bug "
 * (thừa đuôi) và "sửa bug" là một tên duy nhất, gửi PATCH cho nó chỉ tốn
 * một vòng event làm danh sách phiên nhảy.
 *
 * @param {unknown} currentTitle tên đang hiện trên UI
 * @param {unknown} nextTitle tên người dùng vừa gõ
 */
export function isSameSessionTitle(currentTitle, nextTitle) {
  const a = normalizeSessionTitle(currentTitle);
  const b = normalizeSessionTitle(nextTitle);
  if (!a.ok || !b.ok) return false;
  return a.title === b.title;
}

// ---- GHI CHÚ ENDPOINT (đã xác minh từ source OpenWork, không tự chế) ----
//
// PATCH /workspace/{id}/opencode/session/{sessionId}?directory={workspaceDir}
// body: { "title": "<tên phiên mới>" }
//
// Bằng chứng trong source OpenWork (branch dev):
//   - UI desktop đổi tên bằng đúng đường này:
//     apps/app/src/react-app/shell/session-route.tsx:4048-4057 gọi
//     `opencodeClient.session.update({ sessionID, title, directory })` rồi
//     `await refreshRouteState()`.
//   - Mount base = `${mountedBaseUrl}/opencode`:
//     apps/app/src/app/lib/workspace-endpoint.ts:134 và :156 → path đầy đủ là
//     /workspace/{id}/opencode/session/{id}.
//   - Verb PATCH trên path này bị khoá bằng chính test của OpenWork:
//     apps/app/tests/opencode-archive-transport.test.ts:45 (base
//     'http://127.0.0.1:8788/workspace/ws_fixture/opencode'), :51/:58
//     (`method: 'PATCH'`) — cùng đường đó, cùng body dạng object, chỉ khác field.
//   - `directory` đi qua QUERY `?directory=`, KHÔNG nằm trong body — cùng quy
//     tắc với archive (apps/app/tests/opencode-archive-transport.test.ts:61-63).
//   - Server openwork chỉ cắt tiền tố /opencode rồi forward thẳng:
//     apps/server/src/server.ts:618-622 và :1281
//     (`path.replace(/^\\/opencode/, "")`).
//   - Bridge đã whitelist: proxy.js:8 cho phép /workspace/:id/opencode/** và
//     :15 có PATCH trong ALLOWED_METHODS — nên KHÔNG cần mở thêm backend.
//
// ---- GHÉP LẠI (vòng tích hợp sau — KHÔNG tự sửa file dùng chung) ----
//
// 1. api.js — thêm một hàm cạnh nhóm "thao tác trên MỘT session" (api.js:307):
//
//    export async function owRenameSession(wsId, sid, title) {
//      const clean = normalizeSessionTitle(title);
//      if (!clean.ok) throw new Error(clean.error);   // chặn ngay từ client
//      return unwrap(await ow(oc(wsId, `/session/${encodeURIComponent(sid)}`), {
//        method: "PATCH",
//        body: { title: clean.title },
//      }));
//    }
//
//    Dùng helper `oc()` sẵn có ở api.js:311, và `normalizeSessionTitle` từ
//    lib/session-rename.js — đừng viết lại luật trim ở chỗ gọi.
//
// 2. chat.jsx — nút đổi tên cạnh tiêu đề phiên trên đầu màn chat. Ràng buộc
//    của đợt này: html() chỉ nhận PATCH chưa qua `?directory=`, mà web app
//    hiện KHÔNG truyền directory cho bất kỳ call nào của ow() (xem ow() ở
//    api.js:278 — không có tham số directory). Không tự bịa thêm param này;
//    hoặc là endpoint chạy được với session của workspace hiện tại (đã
//    kiểm chứng live với /doc 03/10 như các call khác), hoặc phải mở rộng
//    ow() nhận directory — việc đó thuộc vòng tích hợp, không tự quyết.
//
// 3. sessions.jsx / home.jsx — thay hai chỗ `s.title || "Không tiêu đề"` bằng
//    `sessionTitleOf(s)`, và sau khi đổi tên thì cập nhật state tại chỗ thay
//    vì chờ SSE (SSE ở đây có độ trễ ~700ms, sessions.jsx:41-45).
//
// ---- CHƯA XÁC MINH ----
//
// Trần 120 ký tự ở trên là do file này chốt, không phải trần của engine; xem
// JSDoc của MAX_SESSION_TITLE_LENGTH. Field `title` trong body suy ra từ tham
// số SDK mà app truyền vào, vì node_modules của repo OpenWork không có sẵn
// nên chưa đọc được bảng route của @opencode-ai/sdk để khoá lần cuối tên
// field trên wire. Nếu engine đổi tên field, chỗ hỏng sẽ là body của
// owRenameSession ở trên, không phải hàm thuần trong file này.