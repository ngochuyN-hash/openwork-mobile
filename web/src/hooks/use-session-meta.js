// Phần "đầu phiên": đổi tên (sheet nhập), chia sẻ (link trên máy rồi đưa ra
// điện thoại) và nén hội thoại. Mỗi việc là một PATCH/POST có khoá chạm kép.
import { useRef, useState } from "preact/hooks";
import { owRenameSession, owSummarize, owShareSession, owUnshareSession } from "../api.js";
import {
  UNTITLED_SESSION_LABEL, isSameSessionTitle, normalizeSessionTitle, sessionTitleOf,
} from "../lib/session-rename.js";
import { compactBlockReason } from "../lib/session-compact.js";
import { isShared, parseShareResponse, shareError, shareLink, shareResult } from "../lib/session-share.js";

/**
 * @param {{
 *   wsId: string,
 *   sessionId: string,
 *   session: any,
 *   setSession: (update: any) => void,
 *   setError: (message: string) => void,
 *   setNotice: (message: string) => void,
 *   setBusyAction: (action: string) => void,
 *   loadSession: () => unknown,
 *   loadMessages: () => unknown,
 *   loadStatus: () => unknown,
 *   running: boolean,
 *   model: string,
 *   compact: {turns: number},
 * }} args
 */
export function useSessionMeta({
  wsId, sessionId, session, setSession, setError, setNotice, setBusyAction,
  loadSession, loadMessages, loadStatus, running, model, compact,
}) {
  const [renaming, setRenaming] = useState(false); // mở sheet đổi tên
  const [renameDraft, setRenameDraft] = useState("");
  const [renameErr, setRenameErr] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const renameInputRef = useRef(null);
  // Khoá chạm kép: state (`busyAction`/`shareBusy`) chỉ đổi ở RENDER kế tiếp,
  // nên hai chạm liền nhau vẫn chạy cùng handler cũ và bắn hai PATCH /share.
  const renameLockRef = useRef(false);
  const shareLockRef = useRef(false);

  // ---- Đổi tên phiên: sheet nhập, PATCH xong cập nhật tại chò ----

  function openRename() {
    // Ô nhập mở ra trắng trừ phiên có tên thật — "Không tiêu đề" là nhãn hiển
    // thị, đưa vào ô nhập rồi bấm lưu sẽ đặt tên thành chữ "Không tiêu đề".
    setRenameDraft(sessionTitleOf(session) === UNTITLED_SESSION_LABEL ? "" : String(session?.title ?? ""));
    setRenameErr("");
    setRenaming(true);
  }

  async function saveRename() {
    if (renameLockRef.current) return;
    const clean = normalizeSessionTitle(renameDraft);
    if (!clean.ok) {
      setRenameErr(clean.error); // giữ nguyên nội dung ô nhập, không đóng sheet
      return;
    }
    if (isSameSessionTitle(session?.title, clean.title)) {
      setRenaming(false); // không đổi gì -> khỏi tốn một vòng mạng
      return;
    }
    renameLockRef.current = true;
    setBusyAction("rename");
    setRenameErr("");
    try {
      await owRenameSession(wsId, sessionId, clean.title);
      setSession((prev) => ({ ...(prev ?? {}), title: clean.title }));
      setRenaming(false);
      setError("");
      setNotice(`Renamed the session to “${clean.title}”.`);
      loadSession(); // nguồn chân lý từ máy, độ trễ SSE nên nạp luôn
    } catch (e) {
      setRenameErr(String(e.message || e));
    } finally {
      renameLockRef.current = false;
      setBusyAction("");
    }
  }

  // ---- Chia sẻ: bật/tắt link trên máy, rồi đưa link ra điện thoại ----

  async function toggleShare() {
    if (shareLockRef.current) return;
    shareLockRef.current = true;
    setShareBusy(true);
    const wasShared = isShared(session);
    try {
      const payload = wasShared
        ? await owUnshareSession(wsId, sessionId)
        : await owShareSession(wsId, sessionId);
      const result = parseShareResponse(payload, { unshare: wasShared });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const next = { ...(session ?? {}), share: wasShared ? undefined : { url: result.url } };
      setSession(next);
      setError("");
      if (wasShared) {
        setNotice("Share link for this session is now off.");
        return;
      }
      // Có navigator.share thì mở sheet của máy, không có thì chép link —
      // người dùng chỉ muốn LẤY link để dán, không cần mở tab nào.
      const outcome = await shareLink({
        nav: typeof navigator !== "undefined" ? navigator : null,
        clipboard: typeof navigator !== "undefined" ? navigator.clipboard : null,
        session: next,
        url: result.url,
      });
      setNotice(shareResult(outcome));
    } catch (e) {
      setError(shareError(e));
    } finally {
      shareLockRef.current = false;
      setShareBusy(false);
    }
  }

  // ---- Nén hội thoại: chỉ khi lib/session-compact bảo nên nén ----

  async function compactNow() {
    const blocked = compactBlockReason({ running, turns: compact.turns, busy: compacting });
    if (blocked) {
      setError(blocked);
      return;
    }
    setCompacting(true);
    setError("");
    try {
      await owSummarize(wsId, sessionId, model);
      setNotice("Conversation compacted — the agent will start from the summary.");
      loadSession();
      loadMessages();
      loadStatus();
    } catch (e) {
      setError(`Could not compact the conversation: ${e.message || e}`);
    } finally {
      setCompacting(false);
    }
  }

  return {
    renaming, renameDraft, renameErr, renameInputRef, openRename, saveRename,
    closeRename: () => setRenaming(false),
    shareBusy, toggleShare,
    compacting, compactNow,
  };
}
