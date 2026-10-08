import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import {
  ow, unwrap, owUploadFile,
  owQuestions, owReplyQuestion, owRejectQuestion,
  owRevert, owUnrevert, owFork, owDeleteMessage, owRunCommand, owTodo,
  owRenameSession, owPrompt, owSummarize, owShareSession, owUnshareSession,
} from "../api.js";
import { connectEvents } from "../lib/sse.js";
import { createChatStream, mergeRefetchKeepInflight } from "../lib/chat-stream.js";
import { eventSessionId, sameSession, eventProps } from "../lib/chat-events.js";
import {
  applyRevertCursor, hiddenCountByRevert, resolveForkBoundaryId, messageIdOf,
  messageTextOf, todoProgress, questionsForSession,
  buildQuestionAnswers, shouldClearRevertCursor,
} from "../lib/session-ops.js";
// Tiền phiên: đọc từ TỪNG tin assistant (lib/session-cost) chứ không đọc
// session.cost — ở engine v1 field đó không có, nên màn chat im lặng vĩnh viện.
import { costViewModel } from "../lib/session-cost.js";
import {
  UNTITLED_SESSION_LABEL,
  isSameSessionTitle, normalizeSessionTitle, sessionTitleOf,
} from "../lib/session-rename.js";
import {
  compactBlockReason, compactHint, shouldSuggestCompact, summaryView,
} from "../lib/session-compact.js";
import { shouldShowJump } from "../lib/chat-scroll.js";
import {
  isRetryableSendError, pendingStatus,
  sendDecision, sessionBusyFromMap, shouldRestoreComposer, statusLineIsBusy, permissionReplyBody,
} from "../lib/session-steer.js";
import {
  isShared, parseShareResponse, shareButtonLabel, shareError, shareLink, shareResult,
} from "../lib/session-share.js";
import { Banner } from "../components/ui.jsx";
import { ChatComposer } from "../components/chat-composer.jsx";
import { ChatTranscript, PermissionCard } from "../components/chat-transcript.jsx";
import { RenameSheet, MessageActionSheet, QuestionCard } from "../components/chat-sheets.jsx";
import { useChatOptions } from "../hooks/use-chat-options.js";
import { useChatScroll } from "../hooks/use-chat-scroll.js";
import { useOfflineQueue } from "../hooks/use-offline-queue.js";
import { navigate } from "../app.jsx";

// Protocol event học từ desktop (apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message (info + parts)
//  - message.removed:      message bị xoá/revert — gọt khỏi transcript
//  - session.idle/errored: chốt run status ngay, khỏi đợi poll
// Engine opencode phát event KHÔNG TÊN trên SSE — type nằm trong JSON.

export function ChatPage({ route }) {
  const { wsId, sessionId } = route;
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState(null);
  const [running, setRunning] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [attached, setAttached] = useState([]); // [{file, path?, status:'ready'|'uploading'|'done'|'error', error?}]
  // Model / mức suy luận / agent / slash command (hooks/use-chat-options) và
  // vị trí cuộn (hooks/use-chat-scroll) — mỗi cái giữ ref + effect riêng.
  const {
    models, modelsLoading, model, changeModel, effort, setEffort,
    agents, agent, changeAgent, commands, promptArgs, modelUsable,
  } = useChatOptions({ wsId, sessionId });
  const { atBottom, unseen, jumpToLatest, markTranscriptLoaded } = useChatScroll({ wsId, sessionId, messages });

  // ---- Những thứ engine vốn có, web trước đây bỏ qua ----
  // Con trỏ hoàn tác: session.revert.messageID (engine vẫn trả đủ transcript,
  // client tự cắt — lib/session-ops applyRevertCursor).
  const [revertId, setRevertId] = useState("");
  const [questions, setQuestions] = useState([]); // câu hỏi agent đang chờ (chung)
  const [todos, setTodos] = useState([]);
  const [editing, setEditing] = useState(null); // {messageId, text} — sửa tin đã gửi
  const [menu, setMenu] = useState(null); // message đang mở menu thao tác
  const [busyAction, setBusyAction] = useState(""); // nhãn hành động đang chạy
  const [notice, setNotice] = useState(""); // dòng báo xanh (đổi tên xong, đã chép link…)
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
  // Ô gõ + file đính kèm cất theo phiên, để bấm nhầm Back rồi quay lại không
  // mất chữ vừa gõ mà cũng không mang tin sang phiên khác. Xem chỗ dùng trong
  // effect vào phiên mới.
  const composerRef = useRef(new Map());
  const leftRef = useRef("");
  // Mirror của ô gõ: effect vào phiên mới đọc giá trị CŨ (của phiên đang rời)
  // mà effect đó cố tình không khai báo `draft`/`attached` trong deps — nếu có,
  // mỗi ký tự người dùng gõ sẽ chạy lại effect và dựng lại cả trang chat.
  const draftRef = useRef("");
  draftRef.current = draft;
  const attachedRef = useRef([]);
  attachedRef.current = attached;
  // Phiên ĐANG HIỆN. Mọi loader so `sessionId` của nó với mirror này sau khi
  // await — response về trễ của phiên cũ không được ghi đè phiên mới.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Mốc event SSE cuối + trạng thái running cho watchdog/poll dự phòng.
  const lastEventAt = useRef(Date.now());
  const runningRef = useRef(false);
  runningRef.current = running;
  // Mirror của messages để patch stream đọc-ghi trực tiếp (không đợi render).
  const messagesRef = useRef(null);
  const commitMessages = useCallback((next) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);
  // Reducer stream (lib/chat-stream.js — thuần, có test) + lịch flush theo
  // frame: gom delta rồi đổ một lần, không re-render từng ký tự.
  const streamRef = useRef(null);
  if (!streamRef.current) streamRef.current = createChatStream();
  const flushRef = useRef(null);
  // Đánh dấu "đang sửa tin" để con trỏ hoàn tác được nhả đúng lúc — xem chỗ
  // dùng trong send().
  const revertForNewMessageRef = useRef(false);
  // Khoá gửi theo REF: hai chạm nút Gửi (hoặc Ctrl+Enter hai lần) trong cùng
  // một nhịp render dùng chung handler cũ, nên state `sending` chưa kịp đổi
  // và cả hai lượt đều đi qua. Xem chỗ khoá trong send().
  const sendLockRef = useRef(false);
  // Khoá dừng: `aborting` cũng chỉ đổi ở render kế tiếp, chạm kép sẽ bắn hai
  // request abort (và abort lần hai rơi vào phiên đã rảnh).
  const abortLockRef = useRef(false);
  // Khoá thao tác tin (xoá/hoàn tác/nhánh/trả lời): `busyAction` đổi ở render
  // kế tiếp, chạm kép sẽ chạy thao tác hai lần.
  const actionLockRef = useRef(false);
  // Thẻ "Agent xin phép" đang được trả lời: id để khoá nút, ref để chặn
  // chạm kép trước lúc render kế tiếp.
  const [permissionBusy, setPermissionBusy] = useState("");
  const permissionBusyRef = useRef("");

  const base = `/workspace/${encodeURIComponent(wsId)}/opencode`;

  const loadSession = useCallback(async () => {
    // Chốt phiên như loadMessages: response về trễ không được ghi đè phiên mới.
    const mine = sessionId;
    try {
      const payload = await ow(`${base}/session/${encodeURIComponent(sessionId)}`);
      if (sessionIdRef.current !== mine) return;
      const info = unwrap(payload);
      setSession(info);
      // Con trỏ hoàn tác nằm trên session, không nằm ở message nào.
      setRevertId(info?.revert?.messageID ?? "");
      setError("");
    } catch (e) {
      if (sessionIdRef.current !== mine) return;
      setError(String(e.message || e));
    }
  }, [wsId, sessionId]);

  const loadMessages = useCallback(async () => {
    // Chụp lại phiên MỘT lần rồi so sau khi await: người dùng có thể đã bấm sang
    // phiên khác lúc request đang bay (fork, nút Back, bấm card khác). Không có
    // chốt này, response của phiên CŨ tới sau sẽ ghi đè transcript của phiên mới
    // — và nó còn nuốt luôn cờ "mở phiên thì phải tới đáy", khiến phiên mới mở
    // bằng một lần cuộn smooth từ trên xuống.
    const mine = sessionId;
    try {
      const payload = await ow(`${base}/session/${encodeURIComponent(sessionId)}/message`);
      if (sessionIdRef.current !== mine) return;
      const fetched = unwrap(payload) ?? [];
      // Đánh dấu "đây là transcript thật của phiên" TRƯỚC khi commit — xem
      // `transcriptRef` trong hooks/use-chat-scroll.
      markTranscriptLoaded();
      // Transcript API chỉ flush khi run XONG — giữa chừng fetched thiếu message
      // đang stream; thay nguyên list là trang co cụm, scroll bị hất ngược lên
      // (bug "cuộn xuống tự cuộn lên"). Đang chạy thì giữ message chưa ghi xong.
      commitMessages(
        runningRef.current ? mergeRefetchKeepInflight(fetched, messagesRef.current) : fetched
      );
      setError("");
    } catch (e) {
      if (sessionIdRef.current !== mine) return;
      setError(String(e.message || e));
    }
  }, [wsId, sessionId, commitMessages, markTranscriptLoaded]);

  const loadStatus = useCallback(async () => {
    const mine = sessionId;
    try {
      const payload = await ow(`${base}/session/status`);
      if (sessionIdRef.current !== mine) return;
      // undefined = map không nói gì về phiên này → giữ trạng thái hiện tại,
      // đừng dập tắt busy một cách mù (xem sessionBusyFromMap).
      const busy = sessionBusyFromMap(unwrap(payload) ?? payload, mine);
      if (busy !== undefined) setRunning(busy);
    } catch {
      /* bonus — không có status thì để trạng thái do SSE chốt */
    }
  }, [wsId, sessionId]);

  const loadPermissions = useCallback(async () => {
    // Chốt phiên như mọi loader khác: nếu không, thẻ "Agent xin phép" của phiên
    // ĐÃ RỜI có thể hiện dưới tiêu đề phiên mới, và bấm Cho phép/Từ chối lúc đó
    // là trả lời nhầm cho phiên cũ.
    const mine = sessionId;
    try {
      const payload = await ow(`${base}/permission`);
      if (sessionIdRef.current !== mine) return;
      const list = unwrap(payload) ?? [];
      setPermissions(
        list.filter((p) => sameSession(p.sessionID ?? p.sessionId ?? p.properties?.sessionID, mine))
      );
    } catch {
      if (sessionIdRef.current !== mine) return;
      setPermissions([]);
    }
  }, [wsId, sessionId]);

  // ---- Agent hỏi câu hỏi (GET /question) ----
  // Khác permission: đây là câu hỏi NGƯỜI dùng phải trả lời bằng lời; trước đây
  // web bỏ qua nên agent treo chờ mãi ở bước này.
  const loadQuestions = useCallback(async () => {
    try {
      setQuestions(await owQuestions(wsId));
    } catch {
      /* câu hỏi là bonus - im lặng thay vì báo lỗi */
    }
  }, [wsId]);

  const loadTodo = useCallback(async () => {
    const mine = sessionId;
    try {
      const list = await owTodo(wsId, sessionId);
      if (sessionIdRef.current !== mine) return;
      setTodos(list);
    } catch {
      if (sessionIdRef.current !== mine) return;
      setTodos([]);
    }
  }, [wsId, sessionId]);

  // Hàng đợi offline (hooks/use-offline-queue): tin gửi lúc mất mạng xếp theo
  // phiên, đẩy đi khi có mạng lại.
  const { queueCount, syncCount, enqueue, discard: discardQueue, flush: flushQueue } = useOfflineQueue({
    wsId, sessionId, sessionIdRef, promptArgs, modelUsable, setError, loadMessages, loadStatus,
  });

  useEffect(() => {
    // Vào phiên mới (effect này chạy lại mỗi khi wsId/sessionId đổi): dựng lại
    // từ đầu — (vị trí cuộn do hooks/use-chat-scroll tự dựng lại.)
    // `commitMessages(null)` (chứ không setMessages) để messagesRef khớp,
    // không ló transcript phiên cũ trong lúc chờ phiên mới.
    commitMessages(null);
    // Trạng thái "đang bay" của phiên TRƯỚC không mang ý nghĩa ở phiên mới.
    // Không dọn thì bấm sang phiên đang rảnh vẫn thấy nút Dừng quay và dòng
    // "agent đang chạy…" — người dùng bấm Dừng rồi tưởng lỗi. `running` được
    // chốt lại ngay bởi `loadStatus()` ngay dưới.
    runningRef.current = false;
    setRunning(false);
    setSending(false);
    setAborting(false);
    // Ô gõ và file đính kèm thuộc về phiên đang mở: mang sang phiên khác là
    // gửi nhầm tin của A vào hội thoại B. Nhưng XOÁ thì mất chữ vừa gõ — nên
    // cất lại theo phiên và lấy lại khi quay về (bấm nhầm Back rồi quay lại
    // vẫn còn nguyên ô gõ). `leftRef` là phiên mà state đang mô tả, nên lần
    // chạy đầu tiên không lưu nhầm phiên mới vào làm "phiên đã rời".
    if (leftRef.current && leftRef.current !== sessionId) {
      composerRef.current.set(leftRef.current, { draft: draftRef.current, attached: attachedRef.current });
    }
    leftRef.current = sessionId;
    setEditing(null);
    setDraft(composerRef.current.get(sessionId)?.draft ?? "");
    setAttached(composerRef.current.get(sessionId)?.attached ?? []);
    setRevertId("");
    setMenu(null);
    setNotice("");
    setError("");
    // Đếm tin chờ tính RIÊNG cho từng phiên (lib/session-steer) — đổi phiên
    // thì phải tính lại, không phải giữ số của phiên trước.
    syncCount();
    sendLockRef.current = false;
    abortLockRef.current = false;
    actionLockRef.current = false;
    permissionBusyRef.current = "";
    setPermissionBusy("");
    setPermissions([]);

    loadSession();
    loadMessages();
    loadStatus();
    loadPermissions();
    loadQuestions();
    loadTodo();


    // ---- Streaming theo PART: reducer thuần ở lib/chat-stream.js ----
    // Không còn "đoán snapshot hay delta" trên một chuỗi text chung — chìa là
    // part.id; delta gom vào buffer rồi flush theo frame.
    const scheduleFlush = () => {
      if (flushRef.current != null) return;
      const run = () => {
        flushRef.current = null;
        const prev = messagesRef.current;
        if (prev) commitMessages(streamRef.current.flush(prev));
      };
      // Foreground flush theo frame như desktop; không rAF thì 50ms.
      flushRef.current =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(run)
          : setTimeout(run, 50);
    };

    // Nhịp hỏi lại: event part đã là dữ liệu thật nên KHÔNG refetch full
    // nữa (trước đây mỗi ~900ms fetch lại toàn bộ transcript) — chỉ đồng
    // bộ run-status nhẹ. Refetch full chỉ còn: mount, reconnect, tab trở
    // lại, watchdog 30s.
    let statusTimer = null;
    let otherTimer = null;
    const scheduleStatus = () => {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => loadStatus(), 900);
    };
    const scheduleOther = () => {
      clearTimeout(otherTimer);
      otherTimer = setTimeout(() => {
        loadStatus();
        loadPermissions();
        loadQuestions();
      }, 500);
    };

    // Hạt nhân dispatch — type lấy từ JSON trong dòng `data:` (lib/sse.js bóc
    // sẵn). Engine phát event không tên nên đây là đường chính.
    const handleEvent = (name, data) => {
      lastEventAt.current = Date.now();
      if (name === "server.connected" || name === "server.heartbeat") return;
      if (!data || typeof data !== "object") return;
      if (!sameSession(eventSessionId(data), sessionId)) return;
      if (name === "session.idle" || name === "session.errored" || name === "session.status") {
        // Run kết thúc thật (idle/errored) hoặc status report — chốt ngay,
        // không chờ poll 2.5s. status mang map {ses: {type}} thì tự suy.
        const props = eventProps(data);
        const busy = name === "session.status" ? sessionBusyFromMap(props, sessionId) : false;
        if (name !== "session.status") setRunning(false);
        else if (busy !== undefined) setRunning(busy);
        // Run vừa kết thúc: session có thể vừa bị đổi (cost tăng, con trỏ
        // revert dọn), và todo vừa được chốt — nạp lại cho đúng.
        loadSession();
        loadTodo();
        scheduleStatus();
        return;
      }
      if (name === "permission.updated") {
        loadPermissions();
        scheduleOther();
        return;
      }
      const prev = messagesRef.current;
      const next = streamRef.current.apply(prev ?? [], data);
      if (next !== prev) commitMessages(next);
      if (name === "message.part.updated" || name === "message.part.delta" || name === "message.updated") {
        setRunning(true); // vào guồng stream ngay, poll dự phòng bám theo
        scheduleStatus();
        if (streamRef.current.hasPending()) scheduleFlush();
      } else {
        scheduleOther();
      }
    };
    // Stream qua fetch (lib/sse.js): token đi bằng header Authorization, không
    // phải `?_t=` trên URL, và đứt là tự nối lại với backoff.
    const stopEvents = connectEvents(`/api/ow${base}/event`, handleEvent, {
      onOpen: () => {
        lastEventAt.current = Date.now();
        flushQueue();
      },
      onLost: () => {
        // Stream đứt (tunnel đổi, mobile ngủ, server restart) — refetch full
        // ngay để không đứng hình chờ event kế tiếp.
        loadMessages();
        loadStatus();
      },
    });
    const refetchVisible = () => {
      if (document.visibilityState === "visible") {
        lastEventAt.current = Date.now();
        loadMessages();
        loadStatus();
      }
    };
    const onOnline = () => {
      lastEventAt.current = Date.now();
      flushQueue();
    };
    document.addEventListener("visibilitychange", refetchVisible);
    window.addEventListener("focus", refetchVisible);
    window.addEventListener("online", onOnline);

    return () => {
      clearTimeout(statusTimer);
      clearTimeout(otherTimer);
      if (flushRef.current != null) {
        (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(flushRef.current);
        flushRef.current = null;
      }
      streamRef.current.reset();
      stopEvents();
      document.removeEventListener("visibilitychange", refetchVisible);
      window.removeEventListener("focus", refetchVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [wsId, sessionId, commitMessages]);

  // Poll dự phòng khi agent chạy: chỉ loadStatus (2.5s) — nội dung chữ đến
  // qua stream, không refetch transcript mỗi nhịp nữa. Watchdog 30s không
  // thấy event nào mà vẫn running thì refetch full một lần (kênh chết ngầm).
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => {
      loadStatus();
    }, 2500);
    const watch = setInterval(() => {
      if (runningRef.current && Date.now() - lastEventAt.current > 30_000) {
        lastEventAt.current = Date.now();
        loadMessages();
        loadStatus();
      }
    }, 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(watch);
    };
  }, [running, wsId, sessionId, loadMessages, loadStatus]);

  // ---- Thao tác trên 1 session: hoàn tác / nhánh / sửa / xoá ----
  // Gộp ở một chỗ để mọi thao tác đều: bật busy, báo lỗi rõ, nạp lại thật.

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

  // Nút dừng hiện kèm nút gửi khi agent đang chạy: người dùng vẫn gõ tin
  // xen giữa được (steer), và vẫn dừng được bằng một chạm. `sending` (đang tải
  // file) được ưu tiên để tránh bấm nhầm giữa chừng.
  const busy = running && !sending;

  async function send() {
    const text = draft.trim();
    // Quyết định gửi nằm ở lib/session-steer: session rảnh thì send, agent đang
    // chạy thì STEER (gửi ngay, engine chèn tin vào lượt đang dở — không xếp
    // hàng trong app), còn thiếu nội dung hoặc đang tải file thì mới khoá.
    const decision = sendDecision({ running, sending, text, hasFiles: attached.length > 0 });
    if (decision.action === "wait") return;
    // Khoá bằng REF chứ không bằng state `sending`: state chỉ đổi ở lần render
    // kế tiếp, mà hai chạm (bấm hai lần nút Gửi, Ctrl+Enter hai lần — rất dễ
    // trên điện thoại) dùng CHUNG một handler cũ nên cả hai đều thấy
    // `sending === false` và cùng đi qua. Hệ quả: tin gửi trùng, engine chạy
    // hai lượt. Khoá ở đây, trước cả nhánh hoàn tác của chế độ "sửa tin" —
    // nhánh đó có await nên cửa sổ bấm kép dài hơn nhiều.
    if (sendLockRef.current) return;
    sendLockRef.current = true;
    // Chốt phiên ngay từ đầu: mọi await bên dưới (hoàn tác, upload, gửi) đều
    // có thể bị người dùng cắt ngang bằng một cú bấm Back.
    const mine = sessionId;
    let sent = false;
    try {
      // Sửa tin đã gửi: hoàn tác tới tin cũ TRƯỚC khi gửi, nếu không lịch sử sẽ
      // có cả bản cũ lẫn bản sửa nối sau. Abort nếu đang chạy (desktop làm vậy).
      if (editing) {
        const target = editing.messageId;
        setEditing(null);
        if (running) await ow(`${base}/session/${encodeURIComponent(mine)}/abort`, { method: "POST" }).catch(() => {});
        try {
          await owRevert(wsId, mine, target);
          if (sessionIdRef.current !== mine) return;
          setRevertId(target);
          // Con trỏ này CHỈ để vẽ đúng trạng thái trong khoảnh ngắn giữa lúc
          // hoàn tác xong và tin mới vừa nhảy lên. Giữ nó tới sau khi gửi sẽ cắt
          // luôn tin mới: applyRevertCursor cắt từ vị trí con trỏ trở đi, mà tin
          // mới nối ở CUỐI mảng. Nên nhảy con trỏ khi tin mới đã hiện.
          revertForNewMessageRef.current = true;
        } catch (e) {
          setError(`Could not revert to that message (${e.message || e}) — the new message will follow after.`);
        }
        loadMessages();
      }
      // Upload file đính kèm trước (vào mobile-uploads/), rồi gửi prompt kèm
      // đường dẫn để agent đọc — engine không có part file riêng.
      setSending(true);
      const uploaded = [];
      let failed = false;
      if (attached.length) {
        setAttached((prev) => prev.map((a) => ({ ...a, status: "uploading", error: "" })));
        for (const item of attached) {
          try {
            const path = await owUploadFile(wsId, "mobile-uploads", item.file);
            uploaded.push(path);
            setAttached((prev) => prev.map((a) => (a === item ? { ...a, path, status: "done" } : a)));
          } catch (e) {
            failed = true;
            setAttached((prev) => prev.map((a) => (a === item ? { ...a, status: "error", error: String(e.message || e) } : a)));
          }
        }
      }
      const fileBlock = uploaded.length
        ? `Files attached from the phone (saved in the workspace):\n${uploaded.map((p) => `- ${p}`).join("\n")}\n`
        : "";
      // Chỉ nối bằng xuống dòng KHI có khối file đứng trước — không thì prompt
      // thường bị thừa một dòng trống ở đầu, agent đọc lệch nội dung.
      const fullText = fileBlock
        ? fileBlock + (text ? `\n${text}` : "\nPlease read the attached files above and process them.")
        : text;
      const optimisticText = uploaded.length && !text
        ? `Sent ${uploaded.length} attached files.`
        : fullText;
      setDraft("");
      setAttached([]);
      // Upload mất mấy giây — người dùng có thể đã bấm sang phiên khác. Tin
      // optimistic gắn vào phiên nào thì phải là phiên đang mở, không phải phiên
      // mà `send()` khởi đầu.
      if (sessionIdRef.current !== mine) {
        setSending(false);
        return;
      }
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      // `localSentText` là chữ THẬT sẽ gửi lên máy — khác `optimisticText` khi
      // chỉ đính kèm file. lib/chat-stream dùng nó để ghép bản optimistic với
      // bản engine trả về, thay vì so `time.created` (hai đồng hồ khác nhau).
      commitMessages([
        ...(messagesRef.current ?? []),
        {
          info: { id: localId, role: "user", time: { created: Date.now() }, localSentText: fullText },
          parts: [{ type: "text", text: optimisticText }],
        },
      ]);
      // Sửa tin: vừa đặt con trỏ hoàn tác ở nhánh trên, mà `applyRevertCursor`
      // cắt TỪ con trỏ trở đi — tin vừa gửi nối ở CUỐI mảng nên bị cắt mất và
      // người dùng không thấy tin mình vừa bấm. Nhảy con trỏ ngay khi tin mới
      // đã hiện, và cả khi gửi hỏng — nếu không, tin nằm ẩn vĩnh viễn sau
      // thanh "N tin nhắn phía sau đang ẩn" mà không có lý do gì để bấm "Hiện
      // lại". Đây cũng là lý do cờ `revertForNewMessageRef` tồn tại: nó nhớ
      // việc con trỏ do chính lượt gửi này đặt ra, khác con trổ do người dùng
      // bấm "Hoàn tác" từ trước (cái đó phải giữ tới khi họ gửi tin mới).
      if (revertForNewMessageRef.current) {
        revertForNewMessageRef.current = false;
        setRevertId("");
      }
      try {
        await owPrompt(wsId, mine, promptArgs(fullText));
        sent = true;
        if (sessionIdRef.current !== mine) return;
        setError("");
        // Con trỏ do người dùng bấm "Hoàn tác" từ trước (không phải do lượt
        // gửi này đặt) thì nhảy khi tin mới đã vào lịch sử. Con trỏ do chính
        // lượt sửa tin này đặt đã được nhả ở trên, lúc tin mới vừa hiện.
        if (shouldClearRevertCursor({ sentNewMessage: true, revertMessageId: revertId })) {
          revertForNewMessageRef.current = false;
          setRevertId("");
        }
        loadMessages();
        loadStatus();
      } catch (e) {
        if (sessionIdRef.current !== mine) return;
        const queued = isRetryableSendError(e);
        if (queued) {
          // Mất mạng giữa đường: xếp lại. Tin chờ sẵn có thì GỘP với tin mới
          // thành MỘT prompt nối bằng dòng trống (không tự chèn nhãn/đánh số —
          // đó là chỉ dẫn người dùng không gõ, agent đọc lệch rồi lặp lại).
          enqueue(mine, fullText);
          // KHÔNG nhét tin chờ vào banner lỗi đỏ: mất mạng là chuyện thường, và
          // dòng trạng thái dưới transcript đã nói "Đang gửi lại n tin nhắm…".
        } else {
          // Máy đã trả lời và nói không (4xx): tin sẽ không bao giờ đi. Gỡ bản
          // optimistic — để lại thì transcript hiện vĩnh viễn một tin chưa từng
          // tới máy, và `mergeRefetchKeepInflight` cứ giữ nó mãi. Trả nội dung
          // về ô gõ để sửa rồi gửi lại, thay vì bắt gõ lại từ đầu.
          const list = (messagesRef.current ?? []).filter((m) => messageIdOf(m) !== localId);
          if (list.length !== (messagesRef.current ?? []).length) commitMessages(list);
          if (shouldRestoreComposer({ queued: false })) setDraft(fullText);
          setError(`Could not send the message: ${e.message || e}`);
        }
      } finally {
        setSending(false);
      }
      if (failed && sent) setError("Some files failed to upload — the agent only sees the files that uploaded successfully.");
    } finally {
      sendLockRef.current = false;
    }
  }

  function pickFiles(fileList) {
    const fresh = [...fileList].map((file) => ({ file, path: "", status: "ready", error: "" }));
    setAttached((prev) => [...prev, ...fresh].slice(0, 5));
  }

  async function abort() {
    // Khoá bằng ref: `aborting` chỉ đổi ở render kế tiếp, nên chạm kép vào
    // nút Dừng vẫn chạy cả hai nhánh và bắn hai request abort.
    if (abortLockRef.current) return;
    abortLockRef.current = true;
    const mine = sessionId;
    setAborting(true);
    try {
      await ow(`${base}/session/${encodeURIComponent(mine)}/abort`, { method: "POST" });
      if (sessionIdRef.current !== mine) return;
      // Tắt busy NGAY. Chờ `session.idle` qua SSE là đợi mạng — mà chính lúc
      // đó luồng thường đang yếu nhất. Không tắt thì nút Dừng cứ quay vô
      // hạnh khiến người dùng bấm hoài, và ô gõ cứ báo "agent đang chạy" dù
      // máy đã đứng. `loadStatus` bên dưới vẫn chốt lại nếu máy còn chạy.
      setRunning(false);
      loadStatus();
      loadMessages();
    } catch (e) {
      if (sessionIdRef.current !== mine) return;
      setError(String(e.message || e));
      // Request abort hỏng không có nghĩa agent còn chạy (mất mạng đúng lúc
      // bấm, tunnel chết, 404 vì session vốn đã rảnh). Để màn kẹt ở "đang
      // chạy" thì người dùng bấm Dừng hoài không được và ô gõ cứ báo sai;
      // nói thẳng lỗi rồi để họ tự quyết định gửi tiếp hay không.
      setRunning(false);
    } finally {
      abortLockRef.current = false;
      setAborting(false);
    }
  }

  async function replyPermission(permission, reply) {
    const pid = permission.id ?? permission.requestID;
    // Khoá bằng ref để chạm kép không bắn hai reply cho cùng một thẻ; state
    // bên cạnh chỉ để khoá nút (ref đổi không render lại).
    if (permissionBusyRef.current === pid) return;
    permissionBusyRef.current = pid;
    setPermissionBusy(pid);
    try {
      await ow(`${base}/permission/${encodeURIComponent(pid)}/reply`, {
        method: "POST",
        body: permissionReplyBody(reply),
      });
      setPermissions((prev) => prev.filter((p) => p !== permission));
      loadMessages();
      loadStatus();
    } catch (e) {
      setError(`Could not answer the agent's question: ${e.message || e}`);
    } finally {
      if (permissionBusyRef.current === pid) permissionBusyRef.current = "";
      setPermissionBusy("");
    }
  }

  // Tin đang bị con trỏ revert che khuất — engine vẫn trả về đủ, nên số phải
  // tự đếm để nói "mấy tin đang ẩn" (giống desktop).
  const visible = applyRevertCursor(messages, revertId);
  const hiddenCount = hiddenCountByRevert(messages, revertId);
  const myQuestions = questionsForSession(questions, sessionId);
  const todo = todoProgress(todos);
  // Tiền phiên: cộng theo tin assistant (lib/session-cost). `label` rỗng nghĩa
  // là chưa có gì để hiện — ẩn luôn, đừng in "$0.00" ra màn.
  const costView = useMemo(() => costViewModel(session, messages), [session, messages]);
  // Có nên gợi ý nén + thẻ tóm tắt mới nhất (cùng một lần quét transcript).
  const compact = useMemo(() => shouldSuggestCompact({ messages, running }), [messages, running]);
  const summary = useMemo(() => summaryView(messages), [messages]);
  const title = sessionTitleOf(session);
  // Dòng trạng thái dưới transcript: đang chạy + hàng đợi offline gộp làm một
  // câu (lib/session-steer) để không phải tự chuỗi ở hai chỗ khác nhau.
  const statusLine = pendingStatus({ running, sending, pendingCount: queueCount });
  const statusBusy = statusLineIsBusy({ running, sending });

  return (
    <>
      {error && <div class="banner err" role="alert" aria-live="polite"><span>{error}</span></div>}
      {notice && !error && (
        <div class="banner ok" role="status" aria-live="polite">
          <span>{notice}</span>
        </div>
      )}

      {/* Dải tiêu đề phiên + tiền + hai nút phụ. Nút chính của màn vẫn là ô
          gửi ở dưới; hai nút này là ghost để không cạnh tranh chỗ ngón cái. */}
      <div class="page-head">
        <span class="hint" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={title}>
          {title}
          {costView.label ? ` · ${costView.label}` : ""}
        </span>
        <div class="page-actions">
          <button type="button" class="btn small ghost" onClick={openRename} disabled={Boolean(busyAction)}>
            Rename
          </button>
          <button type="button" class="btn small ghost" onClick={toggleShare} disabled={shareBusy}>
            {shareBusy ? "Working…" : shareButtonLabel(session)}
          </button>
        </div>
      </div>

      {compact.suggest && (
        <Banner
          kind="warn"
          actionLabel={compacting ? "Compacting…" : "Compact conversation"}
          onAction={compactNow}
        >
          {compactHint(compact.level, { turnsSince: compact.turnsSince })}
        </Banner>
      )}

      {myQuestions.map((q) => (
        <QuestionCard
          key={q.id}
          request={q}
          busy={busyAction === "answer"}
          onAnswer={answerQuestion}
          onReject={() =>
            run("answer", async () => {
              await owRejectQuestion(wsId, q.id);
              setQuestions((prev) => prev.filter((x) => x.id !== q.id));
            })
          }
        />
      ))}

      {permissions.map((p) => {
        const pid = p.id ?? p.requestID;
        return (
          <PermissionCard key={pid} permission={p} busy={permissionBusy === pid} onReply={replyPermission} />
        );
      })}

      <ChatTranscript
        wsId={wsId}
        messages={messages}
        visible={visible}
        hiddenCount={hiddenCount}
        summary={summary}
        busyAction={busyAction}
        onUnrevert={unrevert}
        onMenu={setMenu}
        statusLine={statusLine}
        statusBusy={statusBusy}
        queueCount={queueCount}
        onDiscardQueue={discardQueue}
      />

      <ChatComposer
        models={models}
        model={model}
        modelsLoading={modelsLoading}
        onModelChange={changeModel}
        effort={effort}
        onEffortChange={setEffort}
        agents={agents}
        agent={agent}
        onAgentChange={changeAgent}
        todo={todo}
        editing={editing}
        onCancelEdit={() => {
          setEditing(null);
          setDraft("");
        }}
        commands={commands}
        onCommand={(c) => {
          setDraft("");
          run("command", async () => {
            await owRunCommand(wsId, sessionId, { command: c.name });
          });
        }}
        draft={draft}
        onDraft={setDraft}
        attached={attached}
        onPickFiles={pickFiles}
        onRemoveAttached={(a) => setAttached((prev) => prev.filter((x) => x !== a))}
        sending={sending}
        busy={busy}
        aborting={aborting}
        onSend={send}
        onAbort={abort}
        showJump={shouldShowJump({ atBottom, visibleCount: visible.length })}
        unseen={unseen}
        onJump={jumpToLatest}
      />

      {menu && (
        <MessageActionSheet
          message={menu}
          busy={busyAction}
          onClose={() => setMenu(null)}
          onCopy={copyMessage}
          onEdit={startEdit}
          onFork={forkFrom}
          onRevert={revertTo}
          onDelete={deleteMessage}
        />
      )}

      {renaming && (
        <RenameSheet
          initial={renameDraft}
          error={renameErr}
          busy={busyAction === "rename"}
          inputRef={renameInputRef}
          onSave={saveRename}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}

