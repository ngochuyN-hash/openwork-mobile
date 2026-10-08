// Thao tác trên MỘT tin / MỘT phiên: hoàn tác, tạo nhánh, sửa, xoá, chép, trả
// lời câu hỏi của agent. Mọi thao tác đi qua `run` — một chỗ khoá chạm kép, bật
// busy, báo lỗi rõ, nạp lại thật.
import { useRef, useState } from "preact/hooks";
import {
  ow, owRevert, owUnrevert, owFork, owDeleteMessage, owReplyQuestion,
} from "../api.js";
import { navigate } from "../app.jsx";
import {
  resolveForkBoundaryId, messageIdOf, messageTextOf, buildQuestionAnswers,
} from "../lib/session-ops.js";

/**
 * @param {{
 *   wsId: string,
 *   sessionId: string,
 *   sessionIdRef: {current: string},
 *   base: string,
 *   running: boolean,
 *   messagesRef: {current: unknown[] | null},
 *   commitMessages: (next: unknown[] | null) => void,
 *   loadSession: () => Promise<unknown>,
 *   loadMessages: () => unknown,
 *   loadTodo: () => unknown,
 *   setError: (message: string) => void,
 *   setMenu: (message: unknown) => void,
 *   setRevertId: (id: string) => void,
 *   setDraft: (text: string) => void,
 *   setEditing: (editing: {messageId: string, text: string} | null) => void,
 *   setQuestions: (update: (prev: any[]) => any[]) => void,
 * }} args
 */
export function useSessionActions({
  wsId, sessionId, sessionIdRef, base, running, messagesRef, commitMessages,
  loadSession, loadMessages, loadTodo,
  setError, setMenu, setRevertId, setDraft, setEditing, setQuestions,
}) {
  const [busyAction, setBusyAction] = useState(""); // nhãn hành động đang chạy
  // Khoá thao tác tin (xoá/hoàn tác/nhánh/trả lời): `busyAction` đổi ở render
  // kế tiếp, chạm kép sẽ chạy thao tác hai lần.
  const actionLockRef = useRef(false);

  async function run(action, fn) {
    // Khoá bằng ref: `busyAction` chỉ đổi ở render kế tiếp, chạm kép (rất dễ
    // trên điện thoại) sẽ chạy cùng một thao tác hai lần — xoá tin hai lần,
    // hoàn tác hai lần, tạo nhánh hai nhánh mồ côi.
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    const mineSession = sessionId;
    // Lưu ID hành động, không phải nhãn: MessageActionSheet/QuestionCard so
    // busyAction với id ("revert", "answer"…) để bật chữ "Đang làm…".
    setBusyAction(action);
    setError("");
    try {
      await fn();
      // Hành động có thể đã đưa sang phiên khác (Tạo nhánh mới → navigate).
      // Cái loader ở trên đóng từ render CŨ nên nó vẫn trỏ sessionId cũ; nạp
      // lại ở đây sẽ tranh với lần nạp của phiên mới và có thể thắng, để lại
      // transcript phiên cũ dưới tiêu đề phiên mới. Đã sang phiên thì thôi —
      // phiên mới tự nạp trong effect của nó.
      if (sessionIdRef.current !== mineSession) return;
      await loadSession();
      loadMessages();
      loadTodo();
    } catch (e) {
      if (sessionIdRef.current !== mineSession) return;
      setError(String(e.message || e));
    } finally {
      actionLockRef.current = false;
      // Đã sang phiên khác: đừng đụng state của phiên mới — effect vào phiên
      // mới đã tự dọn `busyAction`/`menu` rồi, xoá tiếp ở đây là xoá nhầm
      // trạng thái của màn đang mở (ví dụ câu trả lời agent đang chờ).
      if (sessionIdRef.current === mineSession) {
        setBusyAction("");
        setMenu(null);
      }
    }
  }

  function revertTo(messageId) {
    return run("revert", async () => {
      // Còn run đang chạy thì engine tự chặn; dừng trước cho chắc (desktop làm
      // abort → revert → gửi lại).
      if (running) await ow(`${base}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch(() => {});
      setRevertId(messageId);
      await owRevert(wsId, sessionId, messageId);
    });
  }

  function unrevert() {
    return run("unrevert", async () => {
      setRevertId("");
      await owUnrevert(wsId, sessionId);
    });
  }

  function forkFrom(messageId) {
    return run("fork", async () => {
      // Engine chép tin CHẶT TRƯỚC messageID → phải dò tin kế tiếp làm mốc,
      // nếu không nhánh sẽ mất luôn tin đang bấm.
      const boundary = resolveForkBoundaryId(messagesRef.current ?? [], messageId);
      const created = await owFork(wsId, sessionId, boundary ?? "");
      if (created?.id) {
        navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(created.id)}`);
      }
    });
  }

  function deleteMessage(messageId) {
    return run("delete", async () => {
      // Phải qua commitMessages, không setMessages: messagesRef là bản mirror
      // mà mergeRefetchKeepInflight đọc, nếu không cập nhật nó thì lần refetch
      // kế sẽ lôi tin đã xoá trở lại danh sách.
      commitMessages((messagesRef.current ?? []).filter((m) => messageIdOf(m) !== messageId));
      await owDeleteMessage(wsId, sessionId, messageId);
    });
  }

  async function copyMessage(message) {
    const text = messageTextOf(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setMenu(null);
    } catch {
      setError("Could not copy to the browser clipboard.");
    }
  }

  /** Sửa tin user: đổ nội dung vào ô gõ, đánh dấu để lần gửi tới hoàn tác
   *  tới đúng tin đó (nếu không, chỉ thêm một tin mới cạnh tin cũ). */
  function startEdit(message) {
    const text = messageTextOf(message);
    if (!text) return;
    setDraft(text);
    setEditing({ messageId: messageIdOf(message), text });
    setMenu(null);
  }

  async function answerQuestion(request, selections) {
    await run("answer", async () => {
      await owReplyQuestion(wsId, request.id, buildQuestionAnswers(selections));
      setQuestions((prev) => prev.filter((q) => q.id !== request.id));
    });
  }

  /** Nhả khoá khi vào phiên mới (thao tác dở của phiên cũ không giữ khoá nữa). */
  function resetActionLock() {
    actionLockRef.current = false;
  }

  return {
    busyAction, setBusyAction, run,
    revertTo, unrevert, forkFrom, deleteMessage, copyMessage, startEdit, answerQuestion,
    resetActionLock,
  };
}
