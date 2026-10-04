import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
import {
  ow, unwrap, blobUrlFor, owUploadFile, formatBytes,
  owAgents, owCommands, owQuestions, owReplyQuestion, owRejectQuestion,
  owRevert, owUnrevert, owFork, owDeleteMessage, owRunCommand, owTodo,
  owRenameSession, owPrompt, owSummarize, owShareSession, owUnshareSession,
} from "../api.js";
import { connectEvents } from "../lib/sse.js";
import { createChatStream, mergeRefetchKeepInflight } from "../lib/chat-stream.js";
import { createMarkdownStream } from "../lib/markdown.js";
import {
  applyRevertCursor, hiddenCountByRevert, resolveForkBoundaryId, messageIdOf, messageRoleOf,
  messageErrorOf, messageTextOf, isRealMessageId, todoProgress, questionsForSession, questionView, questionAnswered,
  buildQuestionAnswers, toolRowView, toolStatusVi, filterCommands, shouldClearRevertCursor,
} from "../lib/session-ops.js";
// Tiền phiên: đọc từ TỪNG tin assistant (lib/session-cost) chứ không đọc
// session.cost — ở engine v1 field đó không có, nên màn chat im lặng vĩnh viện.
import { costViewModel } from "../lib/session-cost.js";
import {
  MAX_SESSION_TITLE_LENGTH, UNTITLED_SESSION_LABEL,
  isSameSessionTitle, normalizeSessionTitle, sessionTitleOf,
} from "../lib/session-rename.js";
import {
  compactBlockReason, compactHint, shouldSuggestCompact, summaryView,
} from "../lib/session-compact.js";
// Cuộn màn chat: quyết định "cuộn không / cuộn kiểu nào" và đếm tin mới nằm ở
// lib/chat-scroll.js (thuần, có test) — chat.jsx chỉ đo vị trí và gọi.
import {
  distanceFromBottom, isAtBottom, jumpLabel,
  keepsAutoScroll, leftBottomBy, newMessagesSince, scrollPlan, shouldShowJump,
} from "../lib/chat-scroll.js";
import {
  createQueue, isRetryableSendError, pendingStatus,
  planSteerBatches, queueAdd, queueFor, queueRestore, queueSet, sendDecision,
  sessionBusyFromMap, shouldRestoreComposer, statusLineIsBusy, permissionReplyBody,
} from "../lib/session-steer.js";
import {
  isShared, parseShareResponse, shareButtonLabel, shareError, shareLink, shareResult,
} from "../lib/session-share.js";
import { Banner, Empty, Loading } from "../components/ui.jsx";
import {
  EffortPicker, ModelPicker, loadEffort, pushRecentModel,
} from "../components/model-picker.jsx";
import { isModelUsable, resolveKnownModel } from "../lib/model-behavior.js";
import { navigate } from "../app.jsx";
import { ClipIcon, FileIcon, StopIcon, ToolIcon, ThoughtIcon, ChevronDownIcon, CheckIcon } from "../components/icons.jsx";

// Protocol event học từ desktop (apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message (info + parts)
//  - message.removed:      message bị xoá/revert — gọt khỏi transcript
//  - session.idle/errored: chốt run status ngay, khỏi đợi poll
// Engine opencode phát event KHÔNG TÊN trên SSE — type nằm trong JSON.

// SSE engine các bản trả tên trường khác nhau — nhận hết để khỏi bỏ sót tin.
function eventSessionId(data) {
  if (!data || typeof data !== "object") return "";
  return (
    data.sessionID ??
    data.sessionId ??
    data.session_id ??
    data.properties?.sessionID ??
    data.properties?.sessionId ??
    data.message?.sessionID ??
    data.message?.sessionId ??
    data.part?.sessionID ??
    data.part?.sessionId ??
    ""
  );
}

function sameSession(eventSid, currentSid) {
  if (!eventSid) return true; // event chung (permission/connection) — cứ nhận
  if (eventSid === currentSid) return true;
  const strip = (s) => String(s ?? "").replace(/^ses_/, "");
  return strip(eventSid) === strip(currentSid);
}

/** properties của event: SSE phát {type, properties:{...}} nhưng một số bản
 * bóc sẵn — nhận cả hai. */
function eventProps(data) {
  if (!data || typeof data !== "object") return {};
  const p = data.properties ?? data.part ?? data;
  return p && typeof p === "object" ? p : {};
}

/** Người dùng bảo không động đấy thì cuộn tức thì (luật skill: tôn trọng
 * prefers-reduced-motion). matchMedia có thể vắng ở môi trường test. */
function motionAllowed() {
  try {
    return typeof window?.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * Cuộn tới đáy MÀN (không phải tới `<div>` neo trong transcript).
 *
 * Màn chat cuộn trên window, composer là phần tử sticky nằm CUỐI trang — nên
 * "đáy" chính là cuộn hết document. Cuộn theo neo trong transcript thì neo đó
 * nằm TRÊN composer, màn cuộn tới đó thì composer (sticky) đè lên đuôi tin.
 */
function scrollChatToBottom(plan = "smooth") {
  if (typeof window === "undefined") return;
  const behavior = plan === "instant" || !motionAllowed() ? "auto" : "smooth";
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

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
  const [models, setModels] = useState([]); // [{value:'provider/model', label, providerName, modelName, modelId}]
  const [modelsLoading, setModelsLoading] = useState(true);
  const [model, setModel] = useState(() => localStorage.getItem("owm_model") ?? "");
  const [effort, setEffort] = useState(loadEffort); // mức suy luận (localStorage)
  const [attached, setAttached] = useState([]); // [{file, path?, status:'ready'|'uploading'|'done'|'error', error?}]

  // ---- Những thứ engine vốn có, web trước đây bỏ qua ----
  // Con trỏ hoàn tác: session.revert.messageID (engine vẫn trả đủ transcript,
  // client tự cắt — lib/session-ops applyRevertCursor).
  const [revertId, setRevertId] = useState("");
  const [agents, setAgents] = useState([]);
  const [agent, setAgent] = useState(() => localStorage.getItem("owm_agent") ?? "");
  const [agentOpen, setAgentOpen] = useState(false);
  const [commands, setCommands] = useState([]);
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
  const attachRef = useRef(null);
  const queueRef = useRef(createQueue("", []));
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
  const [queueCount, setQueueCount] = useState(0); // chỉ báo "đang gửi lại (n)"
  // ---- Vị trí cuộn của người dùng ----
  // `atBottomRef` là vị trí THẬT, đo ở nhịp scroll — tức là TRƯỚC nhịp render kế
  // tiếp. Nhờ vậy một khối text/tool dài hơn ngưỡng cũ không làm auto-follow bỏ
  // (xem giải thích ở lib/chat-scroll.js).
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true); // để dựng/ẩn nút "về đáy"
  const unseenRef = useRef(0);
  const [unseen, setUnseen] = useState(0); // số tin mới tới khi người dùng đang đọc lịch sử
  const prevMessagesRef = useRef(null); // transcript lần render trước (đếm tin mới)
  // Đổi session = phải nhảy tới đáy phiên mới; vị trí cuộn của phiên cũ không
  // có ý nghĩa gì ở đây. Cờ này được effect [messages] tiêu thụ một lần.
  const forceBottomRef = useRef(true);
  // Transcript THẬT của phiên đã về chưa. Cờ `forced` chỉ được tiêu khi cờ này
  // bật — nếu không, một tin rác do SSE dựng sẵn (stub cho message chưa từng
  // thấy) có thể nuốt cờ, và lúc transcript thật về ta chỉ còn lệnh smooth từ
  // trên xuống: vào phiên dài lại thày một cuộn lết dài vài giây.
  const transcriptRef = useRef(false);
  // Phiên ĐANG HIỆN. Mọi loader so `sessionId` của nó với mirror này sau khi
  // await — response về trễ của phiên cũ không được ghi đè phiên mới.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Vòng "bám lại đáy" chạy nhiều nhịp (nội dung còn đang lớn thêm sau khi
  // transcript về). Rời trang rồi mà nó còn chạy thì SANG TRANG KHÁC cũng bị
  // cuộn — nên hỏi cờ sống này trước mỗi nhịp.
  const aliveRef = useRef(true);
  const settleTimerRef = useRef(null);
  // Đang cuộn bằng lệnh của app (mở phiên / bấm nút) — cho phép bỏ qua vị trí
  // giữa đường, xem `measure`.
  const autoScrollRef = useRef(false);
  const lastYRef = useRef(0);
  // Mirror của model: flushQueue chạy trong listener SSE/online đóng từ effect
  // cũ (deps không có model) — đọc state thì gửi tin queue đi với model CŨ.
  const modelRef = useRef(model);
  modelRef.current = model;
  // Agent cũng phải có mirror: flushQueue chạy trong listener SSE cũ, đọc state
  // sẽ gửi tin queue đi bằng agent CŨ.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  // Tương tự: mức suy luận và danh sách model nạp bất đồng bộ — gửi tin phải
  // theo mức/model ĐANG CHỌN, không phải bản chụp lúc effect chạy.
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const modelsRef = useRef(models);
  modelsRef.current = models;
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
      // `transcriptRef`.
      transcriptRef.current = true;
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
  }, [wsId, sessionId, commitMessages]);

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

  // Đưa prompt khỏi hàng đợi offline (nếu có) khi có mạng lại.
  // Hàng đợi dài được gộp thành lô ≤8 tin/lượt (lib/session-steer) để đỡ tốn
  // lượt chạy; lô nào máy XÁC NHẬN rồi mới quên, lô nào hỏng giữa chừng thì
  // giữ nguyên để gửi lại — không đoán bừa tin nào đã đi.
  const flushQueue = useCallback(async () => {
    // Chỉ đẩy tin chờ CỦA PHIÊN NÀY. Trang chat sống lâu hơn một phiên, hàng
    // đợi nằm trong ref nên nếu không lọc, tin xếp lúc rò mạng ở phiên A sẽ
    // bị `flushQueue` của phiên B gửi vào hội thoại B.
    const mine = sessionId;
    const waiting = queueFor(queueRef.current, mine);
    if (!waiting.length) return;
    // Model nhớ trong localStorage có thể đã bị engine đổi tên/xoá. Gửi model
    // engine không có thì engine VẪN nhận và lưu message rồi không chạy gì —
    // người dùng thấy "đã gửi" mà không ai trả lời. Chặn ở đây và nói rõ.
    if (!isModelUsable(modelRef.current, modelsRef.current)) {
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

  useEffect(() => {
    // Vào phiên mới (effect này chạy lại mỗi khi wsId/sessionId đổi): dựng lại
    // từ đầu — vị trí cuộn, cờ bám đáy và đếm tin mới của phiên trước không có
    // ý nghĩa ở đây. `commitMessages(null)` (chứ không setMessages) để
    // messagesRef khớp, không ló transcript phiên cũ trong lúc chờ phiên mới.
    forceBottomRef.current = true;
    transcriptRef.current = false;
    atBottomRef.current = true;
    unseenRef.current = 0;
    prevMessagesRef.current = null;
    aliveRef.current = true;
    autoScrollRef.current = false;
    lastYRef.current = typeof window === "undefined" ? 0 : window.scrollY;
    setAtBottom(true);
    setUnseen(0);
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
    setQueueCount(queueFor(queueRef.current, sessionId).length);
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

    // ---- Đo vị trí cuộn: nghe `scroll` (passive), chỉ báo lại khi CỜ đổi ----
    // Đo ở đây tức là đo TRƯỚC nhịp render kế tiếp, nên "đang bám đáy" là vị trí
    // thật của người dùng chứ không phải phép đo sau khi tin mới đã dài ra.
    let scrollTick = null;
    const cancelTick = () => {
      if (scrollTick == null) return;
      (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(scrollTick);
      scrollTick = null;
    };
    const measure = () => {
      scrollTick = null;
      const y = window.scrollY;
      const gap = distanceFromBottom({
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollY: y,
      });
      // Hai quyết định, đều thuộc về lib/chat-scroll.js (có test):
      //   1. Còn cuộn bằng lệnh của app không? Nếu không hỏi, chính lệnh cuộn
      //      của ta bị đọc thành "người dùng đang lướt lên" và tự cuộn chết
      //      giữa lúc stream — bug lớn nhất của màn này.
      //   2. Người dùng đã rời đáy chưa? Vuốt lên là động cửa "cho tôi đọc
      //      lịch sử" nên phải rời vùng bám NGAY, không chờ vượt 260px — nếu
      //      không, lúc agent đang stream thì gần như không lướt lên nổi, và
      //      nút "về tin mới nhất" mất hết ý nghĩa đúng lúc cần nhất.
      const movedUp = y < lastYRef.current - 4;
      if (!keepsAutoScroll({ autoScroll: autoScrollRef.current, gap, movedUp })) {
        autoScrollRef.current = false;
      }
      lastYRef.current = y;
      const now =
        autoScrollRef.current
          ? true
          : !leftBottomBy({ autoScroll: false, gap, movedUp });
      if (now === atBottomRef.current) return; // không đổi cờ thì khỏi render lại
      atBottomRef.current = now;
      setAtBottom(now);
      if (now && unseenRef.current) {
        unseenRef.current = 0;
        setUnseen(0);
      }
    };
    const onScroll = () => {
      if (scrollTick != null) return;
      scrollTick =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(measure)
          : setTimeout(measure, 60);
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Agent + slash command: nạp một lần, rẻ và cần cho composer.
    owAgents(wsId)
      .then((list) => {
        const usable = list.filter((a) => a?.name && a.hidden !== true);
        setAgents(usable);
        // Agent đang chọn (hoặc bản nhớ lần trước) phải còn trong danh sách
        // engine vừa trả. Engine đã xoá thì bỏ hẳn — kể cả localStorage vẫn
        // nhớ tên đó: gửi agent ma lên chỉ nhận lỗi từ engine.
        const wanted = agentRef.current || localStorage.getItem("owm_agent") || "";
        if (!wanted) return;
        if (usable.some((a) => a.name === wanted)) {
          setAgent(wanted); // khôi phục lựa chọn lần trước khi state còn trắng
        } else {
          localStorage.removeItem("owm_agent");
          setAgent("");
        }
      })
      .catch(() => setAgents([]));
    owCommands(wsId).then(setCommands).catch(() => setCommands([]));

    // Model picker: engine yêu cầu model tường minh khi gửi prompt, không có
    // thì message treo vĩnh viễn.
    ow(`${base}/config/providers`)
      .then((payload) => {
        const providers = payload?.providers ?? payload?.data?.providers ?? [];
        const flat = [];
        for (const p of providers) {
          for (const m of Object.values(p.models ?? {})) {
            flat.push({
              value: `${p.id}/${m.id}`,
              label: `${p.name} · ${m.name ?? m.id}`,
              providerName: p.name ?? p.id,
              modelName: m.name ?? m.id,
              modelId: m.id,
              // Danh sách mức suy luận engine khai cho model này. Giữ nguyên
              // shape engine trả; lib/model-behavior bóc ra và KHÔNG bịa thêm
              // mức nào không có trong đây.
              variants: m.variants,
            });
          }
        }
        setModels(flat);
        // Model nhớ trong localStorage có thể đã bị engine đổi tên/xoá — giữ
        // thì mọi tin gửi đi đều im lặng không phản hồi. Chọn lại trong danh
        // sách vừa nhận, và xoá key để lần sau không phải dò lại.
        const kept = resolveKnownModel(modelRef.current, flat);
        if (kept !== modelRef.current) {
          localStorage.setItem("owm_model", kept);
          setModel(kept);
        } else if (!localStorage.getItem("owm_model") && flat.length) {
          localStorage.setItem("owm_model", kept);
          setModel(kept);
        }
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));

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
      aliveRef.current = false;
      clearTimeout(statusTimer);
      clearTimeout(otherTimer);
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      cancelTick();
      window.removeEventListener("scroll", onScroll);
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

  useEffect(() => {
    if (messages === null) return;
    // Quyết định cuộn nằm ở lib/chat-scroll.js. Ba nhánh:
    //   "instant" — lần đầu vào phiên: nhảy tới đáy NGAY, không smooth. Đây là
    //               fix của bug mở phiên dài ra tin cũ nhất (đo gap sau render thì
    //               scrollY=0 + scrollHeight dài => cứ tưởng đang ở lịch sử).
    //   "smooth"  — đang bám đáy thì bám tiếp, kể cả khối mới dài hơn ngưỡng.
    //   "hold"    — người dùng đang lướt lên đọc: không giật, nhưng đếm tin mới.
    // Cờ "mở phiên thì phải tới đáy" chỉ được tiêu khi transcript THẬT về. Một
    // commit SSE stub (message chưa từng thấy, app tự dựng) không phải hồi
    // trọn phiên — tiêu cờ ở đó là mở phiên dài thành một lượt cuộn smooth lết
    // từ trên xuống, đúng cái lỗi ta đang sửa.
    const forced = forceBottomRef.current && transcriptRef.current;
    if (forced) forceBottomRef.current = false;
    const plan = scrollPlan({ forced, atBottom: atBottomRef.current });
    const prev = prevMessagesRef.current;
    prevMessagesRef.current = messages;
    if (plan === "hold") {
      const added = newMessagesSince(prev, messages);
      if (added > 0) {
        unseenRef.current += added;
        setUnseen(unseenRef.current);
      }
      return;
    }
    // MỌI lệnh cuộn của app đều phải bật cờ "đang cuộn tự động" — kể cả nhánh
    // smooth lúc stream. Thiếu bước này thì chính lệnh cuộn của ta làm đổi cờ
    // "đang bám đáy": smooth scroll còn đang chạy thì gap tạm thời lớn hơn
    // ngưỡng, `measure` kết luận người dùng đã lướt lên, và nhịp stream kế
    // tiếp rơi vào nhánh "hold" — tự cuộn chết giữa chừng, đúng cái lỗi mà
    // bản này sinh ra để chữa.
    autoScrollRef.current = true;
    scrollChatToBottom(plan);
    // Transcript vừa nạp: chiều cao trang còn đang lớn thêm (ảnh, khối fold mở
    // ra). Bám lại vài nhịp cho chắc — nhưng dừng ngay khi người dùng chạm
    // cuộn, không giành quyền cuộn của họ.
    if (forced) settleToBottom();
  }, [messages]);

  /** Bám đáy thêm vài nhịp (tối đa ~0.7s) cho tới khi chạm đáy hoặc người dùng
   *  chạm cuộn. Một lần `scrollChatToBottom` là chưa chắc đủ: transcript vừa
   *  nạp còn nội dung cao thêm sau đó (stream tiếp, fold mở, ảnh nạp). */
  function settleToBottom(plan = "instant") {
    let tries = 0;
    autoScrollRef.current = true;
    const step = () => {
      tries += 1;
      // Hết lượt thì TRẢ LẠI quyền đo — nếu giữ cờ "đang cuộn tự động" mãi thì
      // `measure` cứ tưởng người dùng còn ở đáy và nút "về đáy" không bao giờ hiện.
      if (!aliveRef.current || tries > 6) {
        autoScrollRef.current = false;
        return;
      }
      // Người dùng kéo ngược lên giữa chừng → `measure` đã thả quyền, thôi.
      if (!autoScrollRef.current) return;
      const gap = distanceFromBottom({
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      });
      if (isAtBottom(gap, 4)) {
        autoScrollRef.current = false;
        return;
      }
      scrollChatToBottom(plan);
      settleTimerRef.current = setTimeout(step, 120);
    };
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(step, 120);
  }

  /**
   * Tham số gửi prompt, đọc qua ref chứ không đọc state: hàm này chạy cả
   * trong flushQueue — listener đóng từ effect setup lúc mount, state mới
   * không chạm tới được (đọc state ở đây là gửi tin bằng model/mức CŨ).
   *
   * `variants` lấy theo model ĐANG chọn trong catalog: mức suy luận chỉ gửi
   * được với variant engine thật sự khai cho model đó (lib/model-behavior).
   */
  function promptArgs(text) {
    const value = modelRef.current;
    const current = modelsRef.current.find((m) => m.value === value);
    return {
      text,
      model: value,
      agent: agentRef.current,
      effort: effortRef.current,
      variants: current?.variants,
    };
  }

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

  // ---- Về tin mới nhất: đường về đáy khi đang đọc lịch sử ----

  function jumpToLatest() {
    unseenRef.current = 0;
    setUnseen(0);
    lastYRef.current = window.scrollY;
    scrollChatToBottom("smooth");
    settleToBottom("smooth");
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
          queueRef.current = queueAdd(queueRef.current, mine, [fullText]);
          const n = queueFor(queueRef.current, mine).length;
          setQueueCount(n);
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

  /** Bỏ tin chờ của phiên đang mở (xem nút "Bỏ" ở dòng trạng thái). */
  function discardQueue() {
    queueRef.current = queueSet(queueRef.current, sessionId, []);
    setQueueCount(0);
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
        const busy = permissionBusy === pid;
        return (
        <div class="permission-card" key={pid}>
          <b>Agent needs permission</b>
          <div style="margin-top:6px" class="mono">
            {p.title ?? p.pattern ?? JSON.stringify(p).slice(0, 160)}
          </div>
          <div class="actions">
            {/* Ba nút khớp đúng ba giá trị engine nhận (`reply`). Trước đây
                gộp còn hai nút và gửi field sai nên thẻ không bao giờ biến mất
                — xem permissionReplyBody trong lib/session-steer. */}
            <button class="btn small" disabled={busy} onClick={() => replyPermission(p, "once")}>
              Allow
            </button>
            <button class="btn small ghost" disabled={busy} onClick={() => replyPermission(p, "always")}>
              Always allow
            </button>
            <button class="btn small danger" disabled={busy} onClick={() => replyPermission(p, "reject")}>
              Deny
            </button>
          </div>
        </div>
        );
      })}

      <div class="chat-list">
        {/* Tóm tắt sinh ra lúc nén — mặc định ĐÓNG giống hàng tool/suy luận,
            mở mới đọc, không đẩy tin nhắn xuống dưới màn hình. */}
        {summary && (
          <details class="fold-row reasoning">
            <summary>
              <ThoughtIcon size={14} />
              <span class="fold-title">Session summary</span>
              {summary.truncated && <span class="fold-status">truncated</span>}
              <ChevronDownIcon size={12} />
            </summary>
            <div class="fold-body reasoning-body">{summary.text}</div>
          </details>
        )}
        {hiddenCount > 0 && (
          <div class="revert-bar">
            <span>{hiddenCount} older messages hidden</span>
            <button class="btn small" onClick={unrevert} disabled={Boolean(busyAction)}>
              {busyAction === "unrevert" ? "Showing…" : "Show hidden"}
            </button>
          </div>
        )}
        {messages === null && <Loading />}
        {messages?.length === 0 && (
          <Empty title="Empty session" hint="Send the first prompt to the agent." />
        )}
        {visible.length === 0 && messages?.length > 0 && (
          <Empty title="Nothing left to revert" hint="Tap “Show hidden” above to review the hidden messages." />
        )}
        {visible.map((m, i) => (
          <MessageBubble
            key={messageIdOf(m) || `msg-${i}`}
            message={m}
            wsId={wsId}
            onMenu={setMenu}
          />
        ))}
        {/* Dòng trạng thái DUY NHẤT phát ngôn cho screen reader (aria-live):
            trước đây thuộc tính này bọc TOÀN BỘ list tin nhắn — mỗi delta stream
            là đọc lại cả transcript. Vừa làm chỉ báo hàng đợi offline:
            "Đang gửi lại (n)" — hiện duy nhất khi có tin chờ/tác vụ chạy. */}
        <div class="msg assistant chat-status" role="status" aria-live="polite">
          {statusLine && (
            <>
              <span class="spinner" aria-hidden={statusBusy ? undefined : "true"} /> {statusLine}
              {/* Bỏ hàng đợi: mất mạng rồi người dùng gõ nhầm, hoặc đã gửi
                  tay trên máy tính — không có đường thoát thì tin sẽ cứ tự
                  bay lên máy lúc có mạng. Một chạm, không hộp thoại. */}
              {queueCount > 0 && (
                <button
                  type="button"
                  class="btn small ghost"
                  style={{ marginLeft: 8 }}
                  onClick={discardQueue}
                  aria-label={`Discard ${queueCount} queued messages`}
                >
                  Discard
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Nút "về tin mới nhất" neo ngay TRÊN composer. `.composer` đã là
          `position: sticky` nên nó là containing block của phần tử absolute
          bên trong — không phải đoán chiều cao composer (cao không cố định:
          có thêm hàng pill, file đính kèm, dòng todo). */}
      <div class="composer">
        <div style="flex:1;min-width:0">
          <div class="composer-pills">
            <ModelPicker
              models={models}
              value={model}
              loading={modelsLoading}
              onChange={(v) => {
                setModel(v);
                localStorage.setItem("owm_model", v);
                pushRecentModel(v);
              }}
            />
            {/* Mức suy luận: tự ẩn khi model không khai mức nào (chọn xong mới
                biết) — có nút mà bấm không đổi gì thì hỏng trải nghiệm. */}
            <EffortPicker
              modelValue={model}
              variants={models.find((m) => m.value === model)?.variants}
              effort={effort}
              onChange={setEffort}
            />
            {agents.length > 1 && (
              <AgentPicker
                agents={agents}
                value={agent}
                open={agentOpen}
                onToggle={() => setAgentOpen((v) => !v)}
                onClose={() => setAgentOpen(false)}
                onChange={(name) => {
                  setAgent(name);
                  if (name) localStorage.setItem("owm_agent", name);
                  else localStorage.removeItem("owm_agent");
                }}
              />
            )}
          </div>
          {todo.total > 0 && (
            <div class="todo-row" title={todo.next}>
              <span class="todo-count">{todo.done}/{todo.total}</span>
              <span class="todo-next">{todo.next}</span>
            </div>
          )}
          {editing && (
            <div class="editing-bar">
              <span>Edit sent message — resending replaces everything after it</span>
              <button
                class="btn small"
                onClick={() => {
                  setEditing(null);
                  setDraft("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {draft.startsWith("/") && commands.length > 0 && (
            <div class="cmd-pop" role="listbox" aria-label="Quick actions">
              {filterCommands(commands, draft).map((c) => (
                <button
                  key={c.name}
                  role="option"
                  aria-selected="false"
                  class="cmd-item"
                  onClick={() => {
                    setDraft("");
                    run("command", async () => {
                      await owRunCommand(wsId, sessionId, { command: c.name });
                    });
                  }}
                >
                  <span class="cmd-name">/{c.name}</span>
                  <span class="cmd-desc">{c.description ?? c.source}</span>
                </button>
              ))}
            </div>
          )}
          <div style="display:flex;gap:8px">
            <button
              class="btn btn-send"
              style="background:var(--bg-raised);color:var(--text)"
              aria-label="Attach files from the phone"
              disabled={sending}
              onClick={() => attachRef.current?.click()}
            >
              <ClipIcon size={20} />
            </button>
            <input
              ref={attachRef}
              type="file"
              multiple
              hidden
              aria-hidden="true"
              tabindex="-1"
              onChange={(e) => {
                pickFiles([...e.currentTarget.files]);
                e.currentTarget.value = "";
              }}
            />
            <textarea
              aria-label="Enter prompt for the agent"
              rows="1"
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {/* Dừng và Gửi cùng hiện lúc agent chạy: ■ dừng lượt, ➤ chèn tin
                mới vào chính lượt đang dở. Trước đây nút gửi biến mất hẳn
                lúc busy nên không gõ xen được gì. */}
            {busy && (
              <button
                class="btn btn-send stop"
                aria-label="Stop the agent"
                title="Stop the agent"
                disabled={aborting}
                onClick={abort}
              >
                <StopIcon size={20} />
              </button>
            )}
            <button
              class="btn btn-send"
              aria-label={busy ? "Send now, insert into the running turn" : "Send prompt"}
              title={busy ? "Insert this message into the running turn" : "Send prompt"}
              disabled={(!draft.trim() && !attached.length) || sending}
              onClick={send}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m22 2-7 20-4-9-9-4z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          </div>
          {attached.length > 0 && (
            <div class="attach-list">
              {attached.map((a, i) => (
                <span class="attach-chip" key={i}>
                  <span class="name">{a.file.name}</span>
                  <span class="size">
                    {a.status === "uploading" ? "uploading…" : a.status === "error" ? "error" : formatBytes(a.file.size)}
                  </span>
                  <button aria-label={`Remove ${a.file.name}`} onClick={() => setAttached((prev) => prev.filter((x) => x !== a))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Nút "về tin mới nhất" đặt CUỐI composer (dù hình thức nó nằm bên
            phải, cạnh hàng pill) để thứ tự Tab khớp thứ tự nhìn: người dùng đi
            hết ô gõ mới tới nút, không bị dừng ở một nút vô hình giữa
            chừng. Nó là absolute so với `.composer` nên không đẩy layout. */}
        {shouldShowJump({ atBottom, visibleCount: visible.length }) && (
          <button
            type="button"
            class="jump-latest"
            onClick={jumpToLatest}
            aria-label={unseen > 0 ? `Jump to the latest message — ${unseen} new` : "Jump to the latest message"}
          >
            <ChevronDownIcon size={14} />
            {/* aria-live: số "N tin mới" tăng lên là thông tin duy nhất báo
                cho người đọc bằng screen reader rằng có tin mới — không có nó
                thì nút đổi accessible name mà không ai được báo. */}
            <span aria-live="polite">{jumpLabel(unseen)}</span>
          </button>
        )}
      </div>

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

/**
 * Sheet đổi tên phiên. Ô nhập dùng style input sẵn của dự án (16px chống iOS
 * zoom). Lỗi hiện NGAY TRONG sheet và KHÔNG đóng — người dùng không phải gõ
 * lại từ đầu (đúng nguyên tắc "đừng bắt gõ lại").
 */
function RenameSheet({ initial, error, busy, inputRef, onSave, onClose }) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 90);
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Rename session"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <h3>Rename session</h3>
        <label class="field" for="owm-session-title">New name</label>
        <input
          id="owm-session-title"
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          placeholder="e.g. fix login bug"
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        {error && <p class="field-error">{error}</p>}
        <div class="sheet-actions">
          <button type="button" class="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" class="btn primary" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save name"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Menu thao tác 1 tin nhắn (mở bằng cách chạm vào tin). Chỉ hiện nút nào ĐÚNG
 * với loại tin: sửa/xoá là của tin người dùng, chép có khi tin có chữ.
 */
function MessageActionSheet({ message, busy, onClose, onCopy, onEdit, onFork, onRevert, onDelete }) {
  const id = messageIdOf(message);
  const role = messageRoleOf(message);
  const text = messageTextOf(message);
  // Tin client tự sinh (đang gửi tối) không có id thật trên server — mọi thao
  // tác ghi xuống máy đều bỏ qua được, nên không cho bấm.
  const real = isRealMessageId(id);
  const items = [
    text && { id: "copy", label: "Copy content", onSelect: () => onCopy(message) },
    role === "user" && text && { id: "edit", label: "Edit & resend", onSelect: () => onEdit(message) },
    real && { id: "fork", label: "Branch from this message", onSelect: () => onFork(id) },
    real && { id: "revert", label: "Revert to this message", onSelect: () => onRevert(id) },
    real && { id: "delete", label: "Delete message", danger: true, onSelect: () => onDelete(id) },
  ].filter(Boolean);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <p class="sheet-body menu-preview">{text ? text.slice(0, 160) : "(message has no text)"}</p>
        <div class="sheet-actions menu-actions">
          {items.length === 0 && <p class="sheet-body">This message is not saved on the computer yet.</p>}
          {items.map((item) => (
            <button
              key={item.id}
              class={`btn small${item.danger ? " danger" : ""}`}
              disabled={Boolean(busy)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {busy === item.id ? "Working…" : item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Chọn agent (opencode `GET /agent`) — engine nhận `agent` trong prompt. */
function AgentPicker({ agents, value, open, onToggle, onClose, onChange }) {
  const current = agents.find((a) => a.name === value);
  return (
    <>
      <button
        class="model-pill agent-pill"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Current agent: ${current?.name ?? "default"}. Tap to change agent`}
        onClick={onToggle}
      >
        <span class="model-pill-label">{current?.name ?? "Default agent"}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div class="sheet-backdrop" onClick={onClose}>
          <div class="card sheet model-sheet" role="dialog" aria-modal="true" aria-label="Select agent" onClick={(e) => e.stopPropagation()}>
            <div class="sheet-grabber" />
            <div class="model-list" role="listbox" aria-label="Agent list">
              <button
                type="button"
                role="option"
                aria-selected={!value}
                class={`model-option${!value ? " selected" : ""}`}
                onClick={() => {
                  onChange("");
                  onClose();
                }}
              >
                <span class="model-option-text">
                  <span class="model-option-name">Default (not specified)</span>
                  <span class="model-option-sub">The engine picks one based on the computer config</span>
                </span>
                {!value && <CheckIcon size={18} />}
              </button>
              {agents.map((a) => {
                const selected = a.name === value;
                return (
                  <button
                    key={a.name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    class={`model-option${selected ? " selected" : ""}`}
                    onClick={() => {
                      onChange(a.name);
                      onClose();
                    }}
                  >
                    <span class="model-option-text">
                      <span class="model-option-name">{a.name}</span>
                      <span class="model-option-sub">{a.description || a.mode}</span>
                    </span>
                    {selected && <CheckIcon size={18} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Câu hỏi agent đang chờ: chọn nhãn (chọn nhiều nếu câu cho phép) + ô tự nhập. */
function QuestionCard({ request, onAnswer, onReject, busy }) {
  const view = questionView(request);
  const [selections, setSelections] = useState(() => view.items.map(() => []));
  const [custom, setCustom] = useState(() => view.items.map(() => ""));

  function toggle(i, label) {
    setSelections((prev) => {
      const next = prev.map((s, k) => (k === i ? s : s));
      next[i] = next[i].includes(label) ? next[i].filter((l) => l !== label) : [...next[i], label];
      return next;
    });
  }

  const answered = questionAnswered(view, selections, custom);
  const empty = view.items.length === 0;

  return (
    <div class="permission-card q-card">
      <b>The agent needs your answer</b>
      {empty && <p class="sheet-body">The agent asked a question but offered no choices.</p>}
      {view.items.map((item, i) => (
        <div key={i} class="q-item">
          <div class="q-text">{item.question}</div>
          <div class="q-options">
            {item.options.map((o) => {
              const on = selections[i]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  class={`q-option${on ? " on" : ""}`}
                  aria-pressed={Boolean(on)}
                  onClick={() => toggle(i, o.label)}
                >
                  <span class="q-label">{o.label}</span>
                  {o.description && <span class="q-desc">{o.description}</span>}
                </button>
              );
            })}
          </div>
          {item.custom && (
            <input
              type="text"
              class="q-custom"
              aria-label="Or type your own answer"
              placeholder="Or type your own…"
              value={custom[i] ?? ""}
              onInput={(e) => {
                const v = e.currentTarget.value;
                setCustom((prev) => prev.map((c, k) => (k === i ? v : c)));
              }}
            />
          )}
        </div>
      ))}
      <div class="actions">
        <button
          class="btn small"
          disabled={busy || empty || !answered}
          onClick={() =>
            onAnswer(request, view.items.map((item, i) =>
              selections[i]?.length ? selections[i] : custom[i]?.trim() ? [custom[i].trim()] : []
            ))
          }
        >
          {busy ? "Sending…" : "Answer"}
        </button>
        <button
          class="btn small"
          disabled={busy}
          onClick={onReject}
          title="Skip — the agent continues with its own assumption"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message, wsId, onMenu }) {
  // Shape engine: {info:{id,role,time,...}, parts:[...]} - fallback cho cả shape phẳng
  const role = message.info?.role ?? message.role;
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  // Memo hoá: `parts` chỉ là object mới khi message THẬT sự đổi, còn mỗi
  // frame streaming lại tạo props object mới cho mọi bubble. Không memo thì
  // cả transcript quét lại file refs mỗi frame — đo được 7.4 ms/frame ở 200
  // tin, gấp ~8 lần cả phần markdown.
  const files = useMemo(() => (role === "assistant" ? collectFileRefs(parts) : []), [role, parts]);
  // Lượt chạy hỏng: engine để `parts` rỗng và ghi lỗi ở `info.error`. Không hiện
  // nó thì người dùng chỉ thấy tin đã gửi rồi im lặng — đúng cái kiểu lỗi
  // khó chịu nhất, vì không có gì để báo cáo là hỏng.
  const errorText = messageErrorOf(message);
  // Chạm vào tin để mở menu thao tác; bỏ qua bấm vào link/nút bên trong để
  // không cướp mất thao tác mở file hay bấm tool.
  const openMenu = (e) => {
    if (!onMenu) return;
    if (e.target?.closest?.("a,button,summary,[role='button'],input,details")) return;
    onMenu(message);
  };
  return (
    <div class={`msg ${role}`} onClick={openMenu}>
      {errorText && (
        <div class="msg-error" role="alert">
          <strong>The agent reported an error</strong>
          <span>{errorText}</span>
        </div>
      )}
      {parts.map((part, i) => {
        if (part.type === "text") {
          // Tin user giữ text thuần — không đi qua markdown, vừa đúng hành vi
          // cũ vừa khỏi chạy lexer/render rồi bỏ kết quả.
          if (role === "user") return <span key={i} class="msg-text">{part.text}</span>;
          return <MarkdownText key={i} text={part.text} wsId={wsId} />;
        }
        if (part.type === "tool") {
          return <ToolRow key={i} part={part} />;
        }
        if (part.type === "reasoning" && part.text) {
          return <ThoughtRow key={i} part={part} />;
        }
        return null;
      })}
      {files.map((f) => (
        <FileRefCard key={f.path} refPath={f.path} name={f.name} wsId={wsId} />
      ))}
    </div>
  );
}

// ---- Hàng thu gọn kiểu ZCode: tool + suy luận mặc định ĐÓNG, đúng một ----
// dòng (icon + tên + trạng thái + mũi tên), bấm mới xổ nội dung ra xem.
// Tiêu đề + tiền tố lấy từ toolRowView (lib/session-ops) — engine đặt title
// là câu lệnh bash dài, đổ nguyên ra là hàng tràn màn hình.

function ToolRow({ part }) {
  const v = toolRowView(part);
  // Trần hiển thị: transcript tool có khi cả trăm KB — cắt bớt cho điện thoại.
  const MAX = 20_000;
  return (
    <details class="fold-row tool-row">
      <summary>
        <ToolIcon size={14} />
        <span class="fold-title">{v.title || v.label}</span>
        <span class={`fold-status${v.status === "error" ? " err" : ""}${v.status === "running" ? " run" : ""}`}>
          {toolStatusVi(v.status)}
        </span>
        <ChevronDownIcon size={12} />
      </summary>
      <div class="fold-body">
        {v.input && <pre>{safeJson(v.input).slice(0, MAX)}</pre>}
        {v.body && <pre>{v.body.slice(0, MAX)}{v.body.length > MAX ? "\n… (truncated)" : ""}</pre>}
      </div>
    </details>
  );
}

function ThoughtRow({ part }) {
  const streaming = part.state?.status === "streaming";
  return (
    <details class="fold-row reasoning">
      <summary>
        <ThoughtIcon size={14} />
        <span class="fold-title">Reasoning</span>
        <span class={`fold-status${streaming ? " run" : ""}`}>{streaming ? "thinking…" : ""}</span>
        <ChevronDownIcon size={12} />
      </summary>
      <div class="fold-body reasoning-body">{part.text}</div>
    </details>
  );
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---- File agent nhắc tới trong text (engine không có part file riêng) ----
// Quét text + input/output của tool write/edit/bash để tìm đường dẫn file
// agent vừa tạo/sửa, hiện thẻ bấm để tải/mở ngay trong chat.

/** Hậu tố file hay gặp khi agent xuất báo cáo/tài liệu/ảnh. */
const FILE_HINT_EXT =
  /\.(txt|md|markdown|json|jsonc|csv|tsv|log|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|ico|svg|avif|mp4|mp3|wav|zip)\b/i;

function baseNameOf(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);
}

/** Tìm các đường dẫn file trong text (code `...`, đường dẫn Windows, tương đối). */
export function findFileRefsInText(text) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const clean = String(p).replace(/^[<"'“”'(\[]+|[>"'“”'().,;:\]\)]+$/g, "").trim();
    if (!clean || seen.has(clean)) return;
    if (!FILE_HINT_EXT.test(clean)) return;
    if (clean.length > 260) return;
    seen.add(clean);
    out.push({ path: clean, name: baseNameOf(clean) });
  };
  const src = String(text ?? "");
  // 1. Đoạn code `duong/dan/file.ext`
  for (const m of src.matchAll(/`([^`\n]{1,180})`/g)) push(m[1]);
  // 2. Đường dẫn Windows C:\... hoặc C:/...
  for (const m of src.matchAll(/[A-Za-z]:[\\/][^\s"'“”'()[\]<>]{1,180}/g)) push(m[0]);
  // 3. Đường dẫn tương đối có thư mục: thu-muc/file.ext
  for (const m of src.matchAll(/(?:^|[\s"'“”'(\[])([\w\-.À-ỹ]+(?:[\\/][\w\-.À-ỹ ]+)+\.\w{2,5})\b/g)) push(m[1]);
  return out;
}

/** Gom mọi file agent nhắc tới trong 1 message (text + tool input/output). */
function collectFileRefs(parts) {
  const out = [];
  const seen = new Set();
  const add = (ref) => {
    if (!ref || seen.has(ref.path)) return;
    seen.add(ref.path);
    out.push(ref);
  };
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      for (const ref of findFileRefsInText(part.text)) add(ref);
    }
    if (part.type === "tool") {
      const blob = JSON.stringify(part.state?.input ?? {});
      for (const m of blob.matchAll(/"filePath"\s*:\s*"([^"]{1,200})"/g)) {
        const p = m[1];
        if (FILE_HINT_EXT.test(p)) add({ path: p, name: baseNameOf(p) });
      }
      const output = part.state?.output;
      if (typeof output === "string") {
        for (const ref of findFileRefsInText(output.slice(0, 4000))) add(ref);
      }
    }
  }
  return out.slice(0, 5);
}

/** Hàng file trong chat: CHỈ một dòng chữ mảnh (icon + tên + mũi tên) như
 * các hàng tool/suy luận — bấm hàng mới nhảy sang Files mở viewer xem/tải,
 * chat không bị thẻ nút chiếm chỗ. */
function FileRefCard({ refPath, name, wsId }) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const base = `/workspace/${encodeURIComponent(wsId)}`;

  // Agent hay nhắc đường dẫn tuyệt đối Windows (C:\...) hoặc lấy gốc theo ổ
  // đĩa (Persona/...), còn API file hiểu đường dẫn tương đối trong workspace
  // (có khi gốc workspace là thư mục con) — thử cả ba dạng, cái nào có thì dùng.
  function candidates() {
    const out = [refPath];
    const m = /^[A-Za-z]:[\\/]/.exec(refPath);
    let p = refPath;
    if (m) {
      p = refPath.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
      out.push(p);
    } else {
      p = refPath.replace(/\\/g, "/");
    }
    const cut = p.indexOf("/");
    if (cut > 0) out.push(p.slice(cut + 1));
    return out;
  }

  async function open() {
    if (busy) return;
    setBusy(true);
    setMissing(false);
    try {
      let found = "";
      for (const p of candidates()) {
        try {
          // stat KHÔNG ném lỗi khi file thiếu — trả 200 {exists:false}, phải
          // đọc trường exists chứ đừng coi "không ném" là có file.
          const info = await ow(`${base}/files/stat?path=${encodeURIComponent(p)}`);
          if (info?.exists) {
            found = p;
            break;
          }
        } catch {
          /* thử ứng viên tiếp theo */
        }
      }
      if (!found) {
        setMissing(true);
        return;
      }
      // Giao diện xem/tải là trang Files mở thẳng viewer cho file này.
      // Truyền NGUYÊN path vừa stat được (engine nhận cả dạng tuyệt đối) —
      // bóc chữ ổ đĩa ra là viewer dính file_not_found (sai gốc tương đối).
      const norm = String(found).replace(/\\/g, "/");
      const cut = norm.lastIndexOf("/");
      const dir = cut > 0 ? norm.slice(0, cut) : "";
      location.hash = `#/ws/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(dir)}&open=${encodeURIComponent(found)}`;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="file-row">
      <div
        class="file-row-hit"
        role="button"
        tabindex="0"
        aria-label={`Open ${name} in Files`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        <FileIcon size={14} />
        <span class="file-row-name">{name}</span>
        {busy ? (
          <span class="file-row-hint">opening…</span>
        ) : (
          <span class="file-row-chev" aria-hidden="true"><ChevronDownIcon size={12} /></span>
        )}
      </div>
      {missing && (
        <div class="file-row-miss">This file is not in the workspace (the agent may have written it elsewhere).</div>
      )}
    </div>
  );
}

function dirOf(p) {
  const clean = String(p).replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "" : clean.slice(0, i);
}

/** Đường dẫn file trong workspace → link mở trong app.
 *
 *  KHÔNG dựng URL có token: `<a>`/`<img>` không set được header Authorization,
 *  bản cũ dán `?_t=<token>` vào href — chìa đó nằm trong history trình duyệt
 *  và trong Referer của mọi request sau. Nay link trỏ thẳng trang Files (cùng
 *  chỗ hàng file trong chat mở) nên không cần auth trên URL.
 *
 *  `path` giữ nguyên để engine nhận (nó nhận cả `C:\...`); bản `/` chỉ dùng
 *  để bóc thư mục cha cho tham số `path` của hash. */
function makeFileHref(wsId) {
  if (!wsId) return null;
  return (path) => {
    const slash = String(path).replace(/\\/g, "/");
    const cut = slash.lastIndexOf("/");
    const dir = cut > 0 ? slash.slice(0, cut) : "";
    return `#/ws/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(dir)}&open=${encodeURIComponent(path)}`;
  };
}

/** Markdown của bubble assistant, dùng chung engine `marked` + GFM với
 *  OpenWork desktop (lib/markdown.js): bảng, cột số căn phải, bold, heading,
 *  link, blockquote.
 *
 *  Bộ render tăng dần giữ nguyên HTML của block đã chạy xong, vì chat flush
 *  theo frame — parse lại cả message mỗi frame là O(n²). */
function MarkdownText({ text, wsId }) {
  const fileHref = useMemo(() => makeFileHref(wsId), [wsId]);
  const stream = useMemo(() => createMarkdownStream({ fileHref }), [fileHref]);
  const html = useMemo(() => stream.render(text), [stream, text]);
  const rootRef = useRef(null);
  const tableScroll = useRef([]);

  // Gán innerHTML phá hủy hết node con, nên bảng đang được vuốt ngang sẽ
  // nhảy về cột đầu MỖI frame lúc agent còn gõ. Chụp lại scrollLeft lúc
  // render (trước khi DOM đổi — tương đương getSnapshotBeforeUpdate) rồi
  // trả lại sau khi Preact ghi innerHTML.
  if (rootRef.current) {
    tableScroll.current = [...rootRef.current.querySelectorAll(".md-table-wrap")].map((n) => n.scrollLeft);
  }
  useLayoutEffect(() => {
    const wraps = rootRef.current ? rootRef.current.querySelectorAll(".md-table-wrap") : [];
    wraps.forEach((node, i) => {
      if (tableScroll.current[i]) node.scrollLeft = tableScroll.current[i];
    });
  }, [html]);

  // Ảnh trong workspace render ra `<img data-owm-file="đường/dẫn">` CHƯA có
  // `src` (xem markdown.js): `<img>` không set được header nên không thể gắn
  // URL có token. Ở đây fetch bằng header rồi gắn `blob:` — token không bao
  // giờ rời JS.
  //
  // innerHTML bị gán lại mỗi frame lúc stream nên node `<img>` là node MỚI:
  // phải quét lại sau MỖI lần html đổi. Node đã có `src` (đã hydrate) thì
  // bỏ qua — `blobCacheKey` cũng chống việc tải lại cùng một file.
  const imgAlive = useRef(true);
  useEffect(() => {
    imgAlive.current = true;
    return () => {
      imgAlive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wsId || !rootRef.current) return;
    const nodes = [...rootRef.current.querySelectorAll("img[data-owm-file]")].filter((n) => !n.getAttribute("src"));
    if (!nodes.length) return;
    for (const node of nodes) {
      const path = node.getAttribute("data-owm-file");
      blobUrlFor(wsId, path).then(
        (url) => {
          // Node có thể đã bị innerHTML thay mới (stream) hoặc component đã
          // unmount — gắn src vào node chết là vô nghĩa, và vào node của
          // message khác là hiện ảnh sai.
          if (!url || !imgAlive.current || !node.isConnected) return;
          node.setAttribute("src", url);
        },
        () => {
          // Ảnh hỏng: để `alt` của node hiện thay vì im lặng — người dùng
          // vẫn thấy tên/tin nhắn ảnh và có thể bấm link bọc nó để mở Files.
          if (imgAlive.current && node.isConnected) node.setAttribute("data-owm-img-error", "1");
        }
      );
    }
  }, [html, wsId]);

  if (!text) return null;
  return <div class="msg-md" ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
}
