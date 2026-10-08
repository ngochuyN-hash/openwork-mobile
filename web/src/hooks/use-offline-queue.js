// Hàng đợi offline của màn chat: tin gửi lúc mất mạng được xếp lại theo PHIÊN
// rồi đẩy đi khi có mạng. Quyết định gom lô / xếp / khôi phục nằm ở
// lib/session-steer.js (thuần, có test) — hook này giữ ref và nói chuyện với API.
import { useCallback, useRef, useState } from "preact/hooks";
import { owPrompt } from "../api.js";
import {
  createQueue, planSteerBatches, queueAdd, queueFor, queueRestore, queueSet,
} from "../lib/session-steer.js";

/**
 * @param {{
 *   wsId: string,
 *   sessionId: string,
 *   sessionIdRef: {current: string},
 *   promptArgs: (text: string) => object,
 *   modelUsable: () => boolean,
 *   setError: (message: string) => void,
 *   loadMessages: () => unknown,
 *   loadStatus: () => unknown,
 * }} args
 */
export function useOfflineQueue({
  wsId, sessionId, sessionIdRef, promptArgs, modelUsable, setError, loadMessages, loadStatus,
}) {
  const queueRef = useRef(createQueue("", []));
  const [queueCount, setQueueCount] = useState(0); // chỉ báo "đang gửi lại (n)"

  /** Đếm tin chờ tính RIÊNG cho từng phiên — đổi phiên thì phải tính lại, không
   *  phải giữ số của phiên trước. */
  const syncCount = useCallback(() => {
    setQueueCount(queueFor(queueRef.current, sessionId).length);
  }, [sessionId]);

  /** Xếp tin vào hàng đợi của phiên `mine`; trả số tin đang chờ sau khi xếp. */
  const enqueue = useCallback((mine, text) => {
    // Tin chờ sẵn có thì GỘP với tin mới thành MỘT prompt (xem queueAdd).
    queueRef.current = queueAdd(queueRef.current, mine, [text]);
    const n = queueFor(queueRef.current, mine).length;
    setQueueCount(n);
    return n;
  }, []);

  /** Bỏ tin chờ của phiên đang mở (xem nút "Bỏ" ở dòng trạng thái). */
  const discard = useCallback(() => {
    queueRef.current = queueSet(queueRef.current, sessionId, []);
    setQueueCount(0);
  }, [sessionId]);

  // Đưa prompt khỏi hàng đợi offline (nếu có) khi có mạng lại.
  // Hàng đợi dài được gộp thành lô ≤8 tin/lượt (lib/session-steer) để đỡ tốn
  // lượt chạy; lô nào máy XÁC NHẬN rồi mới quên, lô nào hỏng giữa chừng thì
  // giữ nguyên để gửi lại — không đoán bừa tin nào đã đi.
  const flush = useCallback(async () => {
    // Chỉ đẩy tin chờ CỦA PHIÊN NÀY. Trang chat sống lâu hơn một phiên, hàng
    // đợi nằm trong ref nên nếu không lọc, tin xếp lúc rò mạng ở phiên A sẽ
    // bị `flushQueue` của phiên B gửi vào hội thoại B.
    const mine = sessionId;
    const waiting = queueFor(queueRef.current, mine);
    if (!waiting.length) return;
    // Model nhớ trong localStorage có thể đã bị engine đổi tên/xoá. Gửi model
    // engine không có thì engine VẪN nhận và lưu message rồi không chạy gì —
    // người dùng thấy "đã gửi" mà không ai trả lời. Chặn ở đây và nói rõ.
    if (!modelUsable()) {
      setError("The selected model is no longer in your computer's list. Tap the model button to pick another.");
      return;
    }
    // Chốt phiên như mọi loader: người dùng bấm sang phiên khác giữa lúc đang
    // gửi thì phần chưa gửi phải về đúng hàng đợi của phiên cũ, và KHÔNG được
    // setState của màn đang hiển thị phiên mới.
    const batches = planSteerBatches(waiting);
    queueRef.current = queueSet(queueRef.current, mine, []);
    setQueueCount(0);
    for (let i = 0; i < batches.length; i++) {
      try {
        await owPrompt(wsId, mine, promptArgs(batches[i].prompt));
      } catch {
        // Lô này hỏng giữa chừng: giữ nguyên phần CHƯA gửi để thử lại sau —
        // không đoán bừa tin nào đã đi. Lô trước đã được máy xác nhận thì quên.
        const unsent = batches.slice(i).flatMap((b) => b.texts);
        queueRef.current = queueRestore(queueRef.current, mine, unsent);
        if (sessionIdRef.current === mine) {
          setQueueCount(queueFor(queueRef.current, mine).length);
        }
        return;
      }
    }
    if (sessionIdRef.current !== mine) return;
    loadMessages();
    loadStatus();
  }, [wsId, sessionId, loadMessages, loadStatus]);

  return { queueCount, syncCount, enqueue, discard, flush };
}
