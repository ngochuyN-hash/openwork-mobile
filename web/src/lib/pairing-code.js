// Toán đếm ngược cho mã ghép one-time (màn Settings → "Ghép thiết bị khác").
// Tách lib thuần để test được mà không đụng UI: bridge trả `secondsLeft` tại
// THỜI ĐIỂM fetch, điện thoại phải tự quy đổi về mốc tuyệt đối rồi đếm lùi.

/** Giây -> "mm:ss" (mã sống tối đa 30 phút nên mm hai chữ là đủ). Âm kẹp về 00:00. */
export function formatPairingCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Mốc hết hạn tuyệt đối: thời điểm lấy mã + số giây bridge báo còn lại. */
export function pairingDeadline(secondsLeft, nowMs) {
  const n = Number(nowMs) || Date.now();
  const s = Math.max(0, Math.floor(Number(secondsLeft) || 0));
  return n + s * 1000;
}

/** Giây còn lại tính từ mốc — đã qua mốc thì 0 (không bao giờ âm). */
export function pairingSecondsLeft(deadlineMs, nowMs) {
  const n = Number(nowMs) || Date.now();
  const d = Number(deadlineMs) || 0;
  return Math.max(0, Math.round((d - n) / 1000));
}
