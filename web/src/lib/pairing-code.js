// Toán đếm ngược cho mã ghép one-time (màn Settings → "Ghép thiết bị khác").
// Tách lib thuần để test được mà không đụng UI: bridge trả `secondsLeft` tại
// THỜI ĐIỂM fetch, điện thoại phải tự quy đổi về mốc tuyệt đối rồi đếm lùi.
//
// KHÔNG nhân bản bảng chữ cái/độ dài mã ở đây để "kiểm tra sớm": bridge mới là
// nơi quyết định (bridge/src/pairing.js:14-15, :97) và giữ hai bản sao nghĩa
// là mỗi lần sửa bridge là mọi người dùng không ghép được nữa. Xác thực thật
// vẫn nguyên vẹn ở bridge.

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

/**
 * Giây còn lại tính từ mốc — đã qua mốc thì 0 (không bao giờ âm).
 * Dùng `floor` chứ không `round`: bridge đếm bằng `Math.floor`
 * (bridge/src/pairing.js:87). `round` làm đồng hồ điện thoại lệch bridge tới 1
 * giây — đủ để hiện "còn 01:00" khi bridge đã hết hạn, người dùng bấm ghép rồi
 * bị từ chối với lý do "mã không đúng".
 */
export function pairingSecondsLeft(deadlineMs, nowMs) {
  const n = Number(nowMs) || Date.now();
  const d = Number(deadlineMs) || 0;
  return Math.max(0, Math.floor((d - n) / 1000));
}
