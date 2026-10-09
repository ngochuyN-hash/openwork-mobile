// Helpers thuần cho tầng mạng: ghép signal thời gian chờ + phân loại lỗi
// fetch. Tách ra lib để `node --test` khoá được hành vi (app.jsx/api.js là
// JSX/browser nên không import trực tiếp test được).
//
// Vì sao cần: `fetch` tới một tunnel Cloudflare đang treo KHÔNG tự hết —
// promise treo mãi, UI kẹt "đang tải…" với nút không bấm được, không có lối
// ra ngoài trừ việc tải lại trang. Engine desktop chặn tương tự (app/lib/
// opencode.ts:44 DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS). Ở web chưa có nên
// mọi request qua tunnel chết âm thầm đều treo.

/** Lỗi chết cùng signal (AbortError) — không phải lỗi mạng, gọi lại thì vô ích. */
export function isAbortError(error) {
  return error?.name === "AbortError";
}

/**
 * Signal mới hết hạn sau `ms`, kèm hàm hủy. `parent` bị hủy thì cái này cũng
 * hủy theo — đây là điều kiện cần để nút "Hủy" của phần tải file vẫn hoạt động
 * dưới lớp timeout.
 */
export function withTimeoutSignal(parent, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), ms);
  const onParent = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** Lỗi "chìa hết hạn" (401) — api.js ném đúng MỘT identity này, UI hỏi qua
 * `isUnpaired()`. Trước 09/10 nó chỉ là chuỗi "UNPAIRED" trong Error.message và
 * 7 nơi so chuỗi để đoán ý (settings còn 2 câu khác nhau cho cùng điều kiện).
 * Message giữ nguyên "UNPAIRED" để code chưa chuyển cờ vẫn chạy như cũ. */
export function unpairedError() {
  const error = new Error("UNPAIRED");
  error.code = "UNPAIRED";
  error.status = 401;
  return error;
}

/** Đúng lò lỗi 401 của api.js? — hỏi CỜ, đừng so chuỗi message. */
export function isUnpaired(error) {
  return error?.code === "UNPAIRED" || error?.message === "UNPAIRED";
}

/** Phân loại lỗi tầng mạng: "abort" | "timeout" | "offline" | null (null =
 * không phải lỗi mạng — errorSentence dựa vào đây để quyết định có dịch không). */
export function classifyNetworkError(error) {
  if (isAbortError(error)) return "abort";
  const message = String(error?.message ?? "");
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(message)) return "timeout";
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) return "offline";
  return null;
}

/**
 * Thông điệp tiếng Việt cho lỗi tầng mạng, phân biệt ba ca lâm thay vì đổ thẳng
 * "Failed to fetch" (tiếng Anh, không nói được nguyên nhân) lên banner.
 * - offline / không nối được: kiểm tra mạng
 * - hết thời gian chờ: tunnel treo
 * - hủy: không phải lỗi
 */
export function networkErrorMessage(error) {
  const kind = classifyNetworkError(error);
  if (kind === "abort") return "Cancelled.";
  if (kind === "timeout") return "Computer not responding (timed out) — the tunnel may be hanging.";
  if (kind === "offline") return "Could not reach your computer — check your network/Wi-Fi and try again.";
  return String(error?.message ?? "") || "Unknown network error.";
}

export const UNPAIRED_SENTENCE = "Key is no longer valid (401) — pair again to continue.";

/**
 * MỘT chỗ dịch error thành câu cho người dùng — mọi banner đi qua đây thay vì
 * `String(e.message || e)` (trước 09/10 rải ~35 chỗ: lỗi mạng ra tiếng Anh thô
 * "Failed to fetch", chìa hết hạn mỗi nơi một câu). Thứ tự:
 *   1. chìa hết hạn  -> câu chuẩn UNPAIRED_SENTENCE
 *   2. lỗi mạng      -> networkErrorMessage (tiếng Việt, tách timeout/offline)
 *   3. còn lại       -> message của server nguyên văn, hoặc `fallback`
 */
export function errorSentence(error, fallback = "") {
  if (isUnpaired(error)) return UNPAIRED_SENTENCE;
  if (classifyNetworkError(error)) return networkErrorMessage(error);
  // `|| fallback` chứ không `String(error)`: error không lời (`new Error("")`)
  // thì in "Error" trơ trọi vô nghĩa — fallback của caller hữu dụng hơn.
  return String(error?.message ?? "") || fallback;
}
