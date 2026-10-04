import { useId, useState } from "preact/hooks";
import { mergeCandidates } from "../lib/openwork-fix.js";

// Khối "chỉ bridge biết OpenWork.exe nằm ở đâu". Tách ra khỏi pages/settings.jsx
// vì có HAI chỗ dùng: trang Cài đặt và một banner toàn cục báo "chưa thấy exe" ngay
// khi app vừa mở — lúc đó người dùng không vào được Cài đặt để sửa, mà bấm "Bật
// OpenWork" chính là thao tác làm hỏng việc đó.
//
// ĐÃ NỐI VÀO CẢ HAI NƠI (`grep -rn "OpenWorkFix" web/src` ra đúng hai call site):
//   - `pages/settings.jsx` — trong thẻ "Máy của tôi", `onChoose` = `choosePath`.
//   - `app.jsx` — banner trong `StatusBanners`, `onChoose` = `chooseExePath`.
// Khối inline viết tay từng nằm ở settings.jsx đã bị xoá; đây là bản duy nhất.
// Ở route #/settings banner CỐ Ý không vẽ bản thứ hai (`view !== "settings"` ở
// app.jsx) — nếu không sẽ có hai ô "Chỉ đường dẫn" trùng nhãn ngay trong trang.
//
// VÌ SAO component này không tự gọi API:
//   Caller đã có state sẵn (settings.jsx giữ `openworkOverride` để vẽ ngay
//   sau khi chọn; banner tự giữ `fixing`/`fixErr`/`fixMsg` riêng). Nếu component
//   tự fetch thì mỗi chỗ dùng lại một bản sao state riêng, hai nơi lệch nhau
//   sau cú bấm đầu tiên. Ở đây chỉ nhận `candidates` + `onChoose` — component vẽ,
//   caller quyết định dữ liệu.
//
// VÌ SAO dùng `mergeCandidates` chứ không tự `new Set(...).filter(Boolean)`
//   Bản `filter(Boolean)` từng nằm ở settings.jsx chỉ lọc falsy, nên chuỗi toàn
//   khoảng trắng và object truthy lọt và vẽ thành hàng CÓ NÚT "Dùng" — bấm vào
//   sẽ gửi "[object Object]" lên bridge để ghi vào config.json. mergeCandidates
//   (lib/openwork-fix.js) chặn đúng lỗi đó và giữ thứ tự đường dẫn bridge đoán
//   trước luôn ở trên. Logic ở đó, không nhân bản thêm một bản ở đây.
//
// `id` của ô gõ sinh bằng `useId` chứ không hard-code một chuỗi: khi banner
// toàn cục và trang Cài đặt cùng nằm trong DOM, hai label `for` trùng id sẽ
// trỏ nhầm sang nhau và bấm nhãn sai chỗ.
//
// ── CONTRACT `onChoose` — ĐỌC TRƯỚC KHI THÊM CALL SITE THỨ BA ─────────────────
//
// `onChoose(path)` PHẢI là hàm async và PHẢI REJECT khi lưu thất bại.
// Cơ chế bên dưới giữ nguyên đường dẫn trong ô gõ khi promise reject; nếu
// `onChoose` nuốt lỗi rồi resolve thì promise LUÔN resolve, nhánh giữ lại
// không bao giờ chạy, và ô gõ bị xoá cả khi bridge đã từ chối — đúng cái
// điều người dùng phải gõ tay phải tránh.
//
// Cả HAI call site hiện tại ĐÃ ĐÚNG contract này, và cả hai đều xử lý TRƯỜNG HỢP
// thứ hai — HTTP 200 nhưng `openwork.found` false — chứ không chỉ lỗi HTTP:
//   - `choosePath` (settings.jsx) — throw ra ngoài try, setPathErr bằng tiếng Việt.
//   - `chooseExePath` (app.jsx) — throw cả khi HTTP lỗi LẪN khi HTTP 200 mà
//     `openwork.found` false, vì trường hợp sau cũng là "chưa xong".
// Bỏ mắt xích `found:false` ở một chỗ là lỗi người đọc dễ bỏ: lúc đó promise vẫn
// resolve, component xoá sạch ô gõ, và đường dẫn vừa gõ tay mất đúng lúc cần sửa.
// Thêm call site mới thì bắt buộc giữ nguyên: nuốt lỗi rồi resolve sẽ khiến
// người dùng phải gõ lại đường dẫn dài vừa gõ tay ở đúng lúc app chưa thấy exe.
//
// ── VỀ `openworkStatusLabel`: KHÔNG import vào đây, và đó là quyết định đúng ──
//
// `openworkStatusLabel(info, opts)` cần `info.found` + `info.running` và hai
// fallback. Nhãn đó thuộc phần TRẠNG THÁI của trang Cài đặt, không thuộc khối
// chọn đường dẫn này — component này không có chỗ hợp lệ để render nó. Nó đã
// được nối ở đúng chỗ của nó: `pages/settings.jsx` gọi trực tiếp. Đừng thêm
// prop trạng thái vào đây chỉ để "dùng hết" hàm — sẽ tạo ra nguồn nhãn thứ hai
// để lệch. Xem contract + `foundFallback`/`runningFallback` ở lib/openwork-fix.js.
export function OpenWorkFix({ candidates, onChoose, saving, title }) {
  const [manualPath, setManualPath] = useState("");
  const inputId = useId();
  // `mergeCandidates` cố ý nhận NHIỀU nguồn (`...sources`) — nhưng ở đây chỉ
  // truyền MỘT mảng, nên việc gộp là việc của CALLER, component không làm được.
  // Cụ thể settings.jsx phải gộp cả HAI nguồn trước khi truyền vào:
  //   - `state.openwork.candidates` — bridge đoán sẵn lúc /api/state;
  //   - `wakeCandidates` — tích luỹ từ lỗi API khi bấm "Bật OpenWork"
  //     (settings.jsx `wake()` đẩy nguyên `e.candidates`), tức đúng lúc người dùng
  //     cần nhất thì nguồn thứ hai lại mới sinh ra.
  // Truyền thiếu một nguồn thì không có gì báo lỗi: danh sách chỉ NGẮN đi lặng
  // lẽ, và người dùng không biết là còn dòng đáng bấm nữa. Ở đây gọi
  // `mergeCandidates(candidates)` chỉ để LÀM SẠCH một mảng đã gộp sẵn (trim,
  // bỏ rỗng, bỏ trùng, giữ thứ tự) — không thay cho việc gộp đó.
  const list = mergeCandidates(candidates);

  /**
   * Gửi một đường dẫn đã TRIM. Chặn rỗng ở đây chứ không đẩy xuống caller vì
   * nút bấm đã disable khi rỗng — nhưng Enter thì không có chặn nào (người dùng
   * gõ xong bấm Enter kể cả khi chưa gõ gì), và một lần Enter rỗng sẽ bắn
   * `onChoose("")` đi và xoá sạch thông báo lỗi đang hiện.
   */
  function submit(raw) {
    const path = String(raw ?? "").trim();
    if (!path || saving) return;
    const result = onChoose(path);
    // Xoá ô SAU KHI LƯU THÀNH CÔNG, không xoá ngay khi bấm: đường dẫn này
    // người dùng vừa gõ tay (lâu hơn nhiều so với bấm "Dùng"), xoá sớm mà
    // bridge từ chối thì phải gõ lại từ đầu. Nhánh reject GIỮ NGUYÊN đường
    // dẫn — nhưng nó chỉ chạy được nếu `onChoose` reject, xem contract ở JSDoc
    // ngay trên hàm. `onChoose` trả về thứ không phải promise thì giữ ô gõ.
    if (result && typeof result.then === "function") {
      result.then(
        () => setManualPath(""),
        () => {} // lỗi: giữ nguyên đường dẫn để sửa
      );
    }
  }

  return (
    <div>
      {title && <h3>{title}</h3>}

      {list.length > 0 && (
        <div>
          {list.map((p) => (
            <div class="file-row" key={p} style="cursor:default">
              <span class="name mono">{p}</span>
              {/* aria-label kèm đường dẫn: nhãn "Dùng" trần khiến người
                  dùng đọc bằng màn hình nghe N hàng giống hệt nhau, không biết
                  dòng nào ứng với file nào. */}
              <button
                type="button"
                class="btn small"
                aria-label={`Dùng đường dẫn ${p}`}
                disabled={saving}
                onClick={() => submit(p)}
              >
                Dùng
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Nhãn đổi câu theo có ứng viên hay không: khi đã có danh sách thì đây là
          cách THAY THẾ (nên "Hoặc…"), không có thì đây là cách DUY NHẤT —
          nói hằng "Hoặc gõ…" khi không có gì để "hoặc" là người dùng phải đoán
          mình đang bỏ sót danh sách nào. */}
      <label class="field" for={inputId}>
        {list.length > 0
          ? "Hoặc gõ đường dẫn OpenWork.exe trên máy tính"
          : "Gõ đường dẫn OpenWork.exe trên máy tính"}
      </label>
      <div style="display:flex;gap:8px">
        <input
          id={inputId}
          type="text"
          style="flex:1;min-width:0"
          value={manualPath}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setManualPath(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter = gửi luôn. preventDefault để form/điều hướng nào bao quanh
            // (settings nằm trong <form> chưa? hiện chưa, nhưng component này
            // dùng chung thì không do chỗ gọi quyết định) không nuốt mất cú
            // bấm — mất Enter là mất hẳn cách gõ nhanh nhất trên mobile.
            if (e.key === "Enter") {
              e.preventDefault();
              submit(manualPath);
            }
          }}
          placeholder="C:\Users\...\OpenWork.exe"
        />
        <button
          type="button"
          class="btn"
          style="flex:none"
          disabled={saving || !manualPath.trim()}
          onClick={() => submit(manualPath)}
        >
          {saving ? "Đang lưu…" : "Chỉ đường dẫn"}
        </button>
      </div>
      <p class="pair-hint" style="display:block;margin-top:6px">
        Mở File Explorer, chuột phải OpenWork.exe → Copy as path, rồi dán vào đây.
      </p>
    </div>
  );
}