// Unit tests cho web/src/lib/openwork-fix.js — logic thuần của phần "sửa
// OpenWork" (gộp đường dẫn .exe + nhãn nguồn / trạng thái app).
//
// CÁC HÀM NÀY CÓ THẬT SỰ CHẠM TỚI UI KHÔNG — đọc trước khi tin bộ test này
// (cập nhật 2026-10-03, sau khi grep lại toàn bộ call site):
//   - `mergeCandidates` CÓ consumer thật: app.jsx:259 (banner toàn cục) và
//     `pages/settings.jsx` (trang Cài đặt), cả hai truyền HAI nguồn
//     (`state.openwork.candidates` + `wakeCandidates`). Đổi/thu hẹp danh sách
//     ở lib sẽ đổi cả hai màn — test bắt được.
//   - `openworkStatusLabel` CÓ consumer thật: settings.jsx gọi nó dựng nhãn
//     trạng thái. Test bên dưới khoá đúng contract mà UI đang dùng.
//   - `openworkFoundOf` / `openworkRunningOf` CÓ consumer thật ở cả hai call
//     site và trong `openworkStatusLabel`; trước đó guard `typeof === "boolean"`
//     bị viết tay ở bốn chỗ. Test ở đây chặn việc ai đó đổi một bản mà quên bản
//     kia.
// KHÔNG còn test cho `openworkSourceLabel`: hàm đã bị xoá cùng mọi consumer
// (xem mục "TÌNH TRẠNG CONSUMER" ở đầu lib).
//
// Preamble shim bên dưới sao CHÉP NGUYÊN VĂN từ test/api-contract.test.js:
// mkdtempSync cho OPENWORK_BRIDGE_DIR/OPENWORK_DIR đặt TRƯỚC khi import, và
// các global trình duyệt dựng sẵn. openwork-fix.js không có side effect lúc
// import nên không bắt buộc, nhưng giữ nguyên để file này mọc thêm import sau
// này (bridge client, localStorage) vẫn chạy được.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

// House rule: tests never touch a real bridge / openwork data directory.
process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(`${tmpdir()}/owm-test-bridge-`);
process.env.OPENWORK_DIR = mkdtempSync(`${tmpdir()}/owm-test-data-`);

function createStorageShim() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

globalThis.localStorage = createStorageShim();
globalThis.location = { hash: "", pathname: "/", search: "" };
globalThis.history = { replaceState() {} };
globalThis.window = globalThis;

const { mergeCandidates, openworkFoundOf, openworkRunningOf, openworkStatusLabel } = await import(
  "../src/lib/openwork-fix.js"
);

// ---- mergeCandidates() ----

test("mergeCandidates gộp nhiều nguồn thành một danh sách", () => {
  // Hai nguồn thật: bridge `openwork.candidates` và `wakeCandidates` tích lũy
  // từ lỗi API — cả settings.jsx lẫn app.jsx đều đẩy nguyên `e.candidates`
  // (trong `if (e?.candidates?.length)` của `wake()`) không trim.
  assert.deepEqual(
    mergeCandidates(["C:\\ow\\OpenWork.exe"], ["C:\\Users\\hue\\.openwork\\OpenWork.exe"]),
    ["C:\\ow\\OpenWork.exe", "C:\\Users\\hue\\.openwork\\OpenWork.exe"]
  );
  // Nguồn không phải mảng bị bỏ qua, không ném lỗi: `candidates` đến từ JSON
  // qua mạng, payload lạ không được làm sập màn hình Cài đặt.
  assert.deepEqual(mergeCandidates(null, "abc", 42, undefined, ["a.exe"]), ["a.exe"]);
  assert.deepEqual(mergeCandidates(), []);
});

test("mergeCandidates bỏ phần tử rỗng (kể cả toàn khoảng trắng) và bỏ trùng", () => {
  // So VÀ lẫn đẩy trên bản ĐÃ TRIM: nếu không, ["  C:\\a.exe ", "C:\\a.exe"]
  // ra HAI hàng "Dùng" trông y hệt nhau — đúng "dòng giả" cần chặn.
  assert.deepEqual(mergeCandidates(["", "   ", "\t\n"]), []);
  assert.deepEqual(mergeCandidates(["  C:\\a.exe ", "C:\\a.exe", "C:\\b.exe"]), [
    "C:\\a.exe",
    "C:\\b.exe",
  ]);
  // Trùng ở ĐẸP hai nguồn khác nhau, không chỉ trong một mảng.
  assert.deepEqual(mergeCandidates(["C:\\a.exe"], ["C:\\a.exe", "C:\\c.exe"]), [
    "C:\\a.exe",
    "C:\\c.exe",
  ]);
});

test("mergeCandidates GIỮ THỨ TỰ XUẤT HIỆN và trả bản đã trim", () => {
  // Đường dẫn bridge đoán trước phải ở trên: người dùng thường chọn đúng cái
  // đó, đổi thứ tự là hỏng dự đoán của họ.
  assert.deepEqual(mergeCandidates(["c.exe", "a.exe"], ["b.exe", "a.exe"]), [
    "c.exe",
    "a.exe",
    "b.exe",
  ]);
  assert.deepEqual(mergeCandidates(["  a.exe  "]), ["a.exe"]);
});

test("mergeCandidates bỏ phần tử KHÔNG phải chuỗi (không ép String())", () => {
  // Ép thành chuỗi sẽ ra dòng "[object Object]" CÓ NÚT "Dùng" — bấm vào gửi
  // chuỗi vô nghĩa lên bridge để lưu vào config.json.
  assert.deepEqual(
    mergeCandidates([null, undefined, 42, 0, false, true, {}, [], ["nested"], "ok.exe"]),
    ["ok.exe"]
  );
});

// ---- kịch bản đúng call-site thật ----

test("mergeCandidates với đúng hai nguồn settings.jsx và app.jsx truyền vào", () => {
  // settings.jsx     : mergeCandidates(openworkInfo?.candidates, wakeCandidates)
  // app.jsx          : mergeCandidates(state?.openwork?.candidates, wakeCandidates)
  // Nguồn 1 = bridge đoán sẵn, đã trim ở bridge/src/openwork-launch.js:20,23.
  // Nguồn 2 = wakeCandidates tích luỹ từ lỗi API, đẩy NGUYÊN e.candidates nên
  // còn khoảng trắng.
  //
  // Kịch bản quan trọng: bấm "Bật OpenWork" HAI LẦN, mỗi lần lỗi trả về cùng
  // danh sách. app.jsx:300 còn `mergeCandidates(prev, e.candidates)` nên
  // wakeCandidates tự gộp, nhưng state candidates và wake vẫn trùng nhau —
  // đúng cái trùng mà hàm này sinh ra để chặn. Thiếu case này thì một người
  // sửa hàm thành single-arg vẫn xanh, còn danh sách chỉ ngắn đi lặng lẽ.
  const bridgeCandidates = [
    "C:\\Program Files\\OpenWork\\OpenWork.exe",
    "C:\\Users\\hue\\AppData\\Local\\OpenWork\\OpenWork.exe",
  ];
  const wakeCandidates = [
    "  C:\\Users\\hue\\AppData\\Local\\OpenWork\\OpenWork.exe  ", // trùng, có trim
    "C:\\tools\\OpenWork.exe", // mới, phải nối vào CUỐI
    "",
    "   ", // rỗng — settings.jsx vẽ mỗi phần tử thành MỘT hàng có nút
    null,
  ];

  // Đường dẫn bridge đoán trước vẫn ở trên, wake nối vào sau theo thứ tự gặp.
  assert.deepEqual(mergeCandidates(bridgeCandidates, wakeCandidates), [
    "C:\\Program Files\\OpenWork\\OpenWork.exe",
    "C:\\Users\\hue\\AppData\\Local\\OpenWork\\OpenWork.exe",
    "C:\\tools\\OpenWork.exe",
  ]);

  // Gọi lại y hệt (tick /api/state tiếp theo) → không lặp thêm dòng nào.
  assert.deepEqual(
    mergeCandidates(bridgeCandidates, mergeCandidates(wakeCandidates)),
    mergeCandidates(bridgeCandidates, wakeCandidates)
  );

  // Nguồn 1 chưa có (bridge cũ không gửi candidates) → chỉ còn wakeCandidates,
  // vẫn phải sạch. Không được ném lỗi vì `.candidates` là optional chaining.
  assert.deepEqual(mergeCandidates(undefined, wakeCandidates), [
    "C:\\Users\\hue\\AppData\\Local\\OpenWork\\OpenWork.exe",
    "C:\\tools\\OpenWork.exe",
  ]);
  assert.deepEqual(mergeCandidates(null, undefined), []);
});

// ---- openworkFoundOf() / openworkRunningOf() ----

test("openworkFoundOf chỉ tin found khi là boolean THẬT, còn lại lùi về legacyFlag", () => {
  // `Boolean("false")` là true trong JS — nếu ai đó dùng nó, payload rác sẽ mở
  // nguyên mảng "đã cài" cho một exe không tồn tại.
  assert.equal(openworkFoundOf({ found: true }, false), true);
  assert.equal(openworkFoundOf({ found: false }, true), false);
  assert.equal(openworkFoundOf({ found: "false" }, false), false);
  assert.equal(openworkFoundOf({ found: "false" }, true), true, "không phải boolean thì lùi về legacyFlag");
  assert.equal(openworkFoundOf({ found: 0 }, true), true);
  assert.equal(openworkFoundOf({ found: null }, true), true);
  // Bridge đời cũ không gửi object `openwork`.
  assert.equal(openworkFoundOf(undefined, true), true);
  assert.equal(openworkFoundOf(null, true), true);
  assert.equal(openworkFoundOf({}, false), false);
  // Thiếu cả hai → coi như chưa cài, không ném TypeError.
  assert.equal(openworkFoundOf(null), false);
  assert.equal(openworkFoundOf(undefined, undefined), false);
});

test("openworkRunningOf áp đúng quy tắc boolean cho running", () => {
  assert.equal(openworkRunningOf({ running: true }, false), true);
  assert.equal(openworkRunningOf({ running: false }, true), false, "running boolean là nguồn chính, fallback không ghi đè");
  assert.equal(openworkRunningOf({ running: "yes" }, true), true);
  assert.equal(openworkRunningOf({ running: "yes" }, false), false);
  // settings.jsx/app.jsx truyền `Boolean(state?.server)` làm legacyFlag.
  assert.equal(openworkRunningOf({}, true), true);
  assert.equal(openworkRunningOf({ running: 1 }, false), false);
  assert.equal(openworkRunningOf(null), false);
});

// ---- openworkStatusLabel() ----
// ĐÃ NỐI UI: `pages/settings.jsx` gọi hàm này dựng nhãn trạng thái, nên các test
// bên dưới khoá đúng contract mà màn hình đang dựng. Sửa hàm thì test đỏ và
// UI đổi theo — đây là bằng chứng, không phải lưới an toàn.

test("openworkStatusLabel: running=true -> 'đang chạy', running=false -> 'đã cài, chưa mở'", () => {
  assert.equal(openworkStatusLabel({ found: true, running: true }), "đang chạy");
  assert.equal(openworkStatusLabel({ found: true, running: false }), "đã cài, chưa mở");
});

test("openworkStatusLabel trả CHUỖI RỖNG khi chưa tìm thấy exe", () => {
  // Chuỗi rỗng KHÔNG phải "ẩn đi được": settings.jsx vẽ cả khối bảng khi
  // openworkFound là true, nên lấy found từ nguồn A còn nhãn từ info rỗng sẽ
  // để trống hàng "Tình trạng".
  assert.equal(openworkStatusLabel({ found: false, running: true }), "");
  assert.equal(openworkStatusLabel({ found: false, running: false }), "");
  assert.equal(openworkStatusLabel(null), "");
  assert.equal(openworkStatusLabel(undefined), "");
  assert.equal(openworkStatusLabel({}), "");
  // opts truyền `null` không được ném TypeError.
  assert.equal(openworkStatusLabel(null, null), "");
});

test("openworkStatusLabel dùng foundFallback khi found KHÔNG phải boolean", () => {
  // Boolean CŨ bridge gửi (bridge/src/index.js:400).
  assert.equal(openworkStatusLabel(null, { foundFallback: true, runningFallback: true }), "đang chạy");
  assert.equal(openworkStatusLabel({ running: true }, { foundFallback: true }), "đang chạy");
  assert.equal(openworkStatusLabel(null, { foundFallback: false, runningFallback: true }), "");
  // found là boolean thì là nguồn chính — fallback KHÔNG được ghi đè.
  assert.equal(openworkStatusLabel({ found: false }, { foundFallback: true, runningFallback: true }), "");
  assert.equal(openworkStatusLabel({ found: true }, { foundFallback: false }), "đã cài, chưa mở");
  // found: "false" là chuỗi (truthy trong JS) nên KHÔNG tin, lùi về fallback.
  assert.equal(openworkStatusLabel({ found: "false" }, { foundFallback: true, runningFallback: true }), "đang chạy");
  assert.equal(openworkStatusLabel({ found: "false" }, { foundFallback: false }), "");
});

test("openworkStatusLabel dùng runningFallback khi running KHÔNG phải boolean", () => {
  assert.equal(
    openworkStatusLabel({ found: true, running: "yes" }, { runningFallback: true }),
    "đang chạy"
  );
  assert.equal(
    openworkStatusLabel({ found: true, running: "yes" }, { runningFallback: false }),
    "đã cài, chưa mở"
  );
  // running boolean là nguồn chính, fallback không ghi đè.
  assert.equal(
    openworkStatusLabel({ found: true, running: false }, { runningFallback: true }),
    "đã cài, chưa mở"
  );
  assert.equal(
    openworkStatusLabel({ found: true, running: true }, { runningFallback: false }),
    "đang chạy"
  );
  // Thiếu cả hai fallback: coi như chưa cài / chưa chạy — nhãn đổi từ
  // "đang chạy" sang "đã cài, chưa mở" sẽ bật thêm một cảnh báo sai.
  assert.equal(openworkStatusLabel({ found: true }), "đã cài, chưa mở");
  assert.equal(openworkStatusLabel({ found: true }, {}), "đã cài, chưa mở");
  assert.equal(openworkStatusLabel({ found: true, running: 1 }), "đã cài, chưa mở");
  assert.equal(openworkStatusLabel({ found: true, running: null }), "đã cài, chưa mở");
});
