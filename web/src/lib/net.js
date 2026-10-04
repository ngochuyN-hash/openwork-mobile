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

/**
 * Thông điệp tiếng Việt cho lỗi tầng mạng, phân biệt ba ca lâm thay vì đổ thẳng
 * "Failed to fetch" (tiếng Anh, không nói được nguyên nhân) lên banner.
 * - offline / không nối được: kiểm tra mạng
 * - hết thời gian chờ: tunnel treo
 * - hủy: không phải lỗi
 */
export function networkErrorMessage(error) {
  if (isAbortError(error)) return "Đã hủy.";
  const message = String(error?.message ?? "");
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(message)) {
    return "Máy tính không phản hồi (hết thời gian chờ) — đường hầm có thể đang treo.";
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return "Không nối được tới máy tính — kiểm tra mạng/Wi-Fi rồi thử lại.";
  }
  return message || "Lỗi mạng không xác định.";
}
