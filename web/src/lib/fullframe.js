// Nhận diện FULL FRAME cho screen viewer (web): nền chỉ được dựng từ khung đủ
// cỡ theo mốc META (shot dims), không phải theo canvas mặc định 300×150 — crop
// dải ở (0,0) với diện tích ≥ 0.9×canvas kia từng lọt qua gate rồi CSS kéo dãn
// ra cả màn hình (lỗi "tự focus" 14/09). Dùng chung cho gate khung đầu và điều
// kiện resize canvas: CHỈ full frame mới được đổi cỡ canvas.

export const FULL_RATIO = 0.95;

/**
 * (x,y,w,h) = vùng frame từ header [2B×4] LE; tw/th = cỡ khung chụp đích (meta).
 * Full = bắt đầu tại (0,0) và phủ ≥ 95% CẢ HAI chiều. Crop hợp lệ ở (0,0) (vùng
 * đổi chạm góc trên-trái, daemon crop < 60% diện tích) vẫn bị loại vì thiếu
 * chiều cao. Chưa biết cỡ đích (tw/th = 0) → trả false: caller tự quyết đường
 * lùi, không đoán bừa.
 */
export function isFullFrameShot(x, y, w, h, tw, th) {
  if (x !== 0 || y !== 0) return false;
  if (!(tw > 0) || !(th > 0)) return false;
  return w >= tw * FULL_RATIO && h >= th * FULL_RATIO;
}