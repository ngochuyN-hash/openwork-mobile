// Soạn tin đi ra (optimistic) của màn chat — tách khỏi send() của
// pages/chat.jsx (round 4, 09/10): luật ghép khối file + chữ, và hình dạng
// message local gắn tạm trước khi engine xác nhận, đều là logic thuần cần test.
// Ghép với lib/chat-stream khi bản engine thật về (chìa `localSentText`).

/**
 * Ghép chữ người gõ với danh sách file đã upload thành MỘT prompt.
 * - Có file: khối liệt kê file đứng trước, chữ gõ nối sau bằng xuống dòng; chỉ
 *   có file không có chữ thì nhét lời dặn đọc file (agent đọc lệch nếu không).
 * - Chỉ nối bằng xuống dòng KHI có khối file — prompt thường không bị thừa
 *   dòng trống ở đầu.
 * - `optimisticText` là chữ HIỂN THỊ tạm (chỉ file thì hiện "Sent N files"),
 *   `fullText` là chữ THẬT gửi lên máy — khác nhau để ghép bản engine trả về.
 */
export function composeOutgoing({ text, uploaded = [] }) {
  const fileBlock = uploaded.length
    ? `Files attached from the phone (saved in the workspace):\n${uploaded.map((p) => `- ${p}`).join("\n")}\n`
    : "";
  const fullText = fileBlock
    ? fileBlock + (text ? `\n${text}` : "\nPlease read the attached files above and process them.")
    : text;
  const optimisticText = uploaded.length && !text ? `Sent ${uploaded.length} attached files.` : fullText;
  return { fullText, optimisticText };
}

/**
 * Message local gắn vào transcript NGAY (chờ engine xác nhận): id local để gỡ
 * nếu máy từ chối, `localSentText` là chữ thật sẽ gửi — lib/chat-stream dùng
 * nó để ghép bản engine trả về, thay vì so `time.created` (hai đồng hồ khác
 * nhau). `now` injectable để test.
 */
export function optimisticMessage(fullText, optimisticText, now = Date.now()) {
  const localId = `local-${now}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    localId,
    message: {
      info: { id: localId, role: "user", time: { created: now }, localSentText: fullText },
      parts: [{ type: "text", text: optimisticText }],
    },
  };
}
