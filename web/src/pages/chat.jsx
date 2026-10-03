import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { ow, unwrap, sseUrl, owUploadFile, formatBytes } from "../api.js";
import { Banner, Empty, Loading } from "../components/ui.jsx";
import { ModelPicker, pushRecentModel } from "../components/model-picker.jsx";
import { ClipIcon, ExpandIcon, FileIcon, StopIcon } from "../components/icons.jsx";

// Protocol event học từ desktop (apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message (info + parts)
//  - message.removed:      message bị xoá/revert — gọt khỏi transcript
//  - session.idle/errored: chốt run status ngay, khỏi đợi poll
const SSE_EVENTS = [
  "session.updated",
  "session.deleted",
  "session.errored",
  "session.idle",
  "session.status",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.removed",
  "permission.updated",
  "connection.updated",
];

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

function eventMessageId(data) {
  if (!data || typeof data !== "object") return "";
  return (
    data.messageID ??
    data.messageId ??
    data.message_id ??
    data.info?.id ??
    data.message?.id ??
    data.message?.info?.id ??
    data.part?.messageID ??
    data.part?.messageId ??
    data.properties?.messageID ??
    data.properties?.messageId ??
    data.properties?.part?.messageID ??
    ""
  );
}

/** properties của event: SSE phát {type, properties:{...}} nhưng một số bản
 * bóc sẵn — nhận cả hai. */
function eventProps(data) {
  if (!data || typeof data !== "object") return {};
  const p = data.properties ?? data.part ?? data;
  return p && typeof p === "object" ? p : {};
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
  const [attached, setAttached] = useState([]); // [{file, path?, status:'ready'|'uploading'|'done'|'error', error?}]
  const attachRef = useRef(null);
  const queueRef = useRef([]);
  const [queueCount, setQueueCount] = useState(0); // chỉ báo "đang gửi lại (n)"
  const bottomRef = useRef(null);
  const draftRef = useRef("");
  draftRef.current = draft;
  // Mirror của model: flushQueue chạy trong listener SSE/online đóng từ effect
  // cũ (deps không có model) — đọc state thì gửi tin queue đi với model CŨ.
  const modelRef = useRef(model);
  modelRef.current = model;
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
  // Delta buffer theo partId (học desktop pendingDeltas + deltaFlushBuffer):
  // gom chữ rồi flush theo frame, không re-render từng miếng.
  const pendingDelta = useRef(new Map());
  const flushRef = useRef(null);

  const base = `/workspace/${encodeURIComponent(wsId)}/opencode`;

  const loadSession = useCallback(async () => {
    try {
      const payload = await ow(`${base}/session/${encodeURIComponent(sessionId)}`);
      setSession(unwrap(payload));
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [wsId, sessionId]);

  const loadMessages = useCallback(async () => {
    try {
      const payload = await ow(`${base}/session/${encodeURIComponent(sessionId)}/message`);
      commitMessages(unwrap(payload) ?? []);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [wsId, sessionId, commitMessages]);

  const loadStatus = useCallback(async () => {
    try {
      const payload = await ow(`${base}/session/status`);
      const map = unwrap(payload) ?? payload ?? {};
      setRunning(map[sessionId]?.type === "busy" || map[`ses_${sessionId}`]?.type === "busy");
    } catch {
      /* bonus */
    }
  }, [wsId, sessionId]);

  const loadPermissions = useCallback(async () => {
    try {
      const payload = await ow(`${base}/permission`);
      const list = unwrap(payload) ?? [];
      setPermissions(
        list.filter((p) => sameSession(p.sessionID ?? p.sessionId ?? p.properties?.sessionID, sessionId))
      );
    } catch {
      setPermissions([]);
    }
  }, [wsId, sessionId]);

  // Đưa prompt khỏi hàng đợi offline (nếu có) khi có mạng lại
  const flushQueue = useCallback(async () => {
    while (queueRef.current.length) {
      const text = queueRef.current[0];
      try {
        await ow(`${base}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
          method: "POST",
          body: { parts: [{ type: "text", text }], ...(modelBody() ? { model: modelBody() } : {}) },
        });
        queueRef.current = queueRef.current.slice(1);
        setQueueCount(queueRef.current.length);
      } catch {
        return; // vẫn mất mạng - giữ lại lần sau
      }
    }
    loadMessages();
    loadStatus();
  }, [wsId, sessionId, loadMessages, loadStatus]);

  useEffect(() => {
    loadSession();
    loadMessages();
    loadStatus();
    loadPermissions();

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
            });
          }
        }
        setModels(flat);
        if (!localStorage.getItem("owm_model") && flat.length) {
          localStorage.setItem("owm_model", flat[0].value);
          setModel(flat[0].value);
        }
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));

    // ---- Streaming patch theo PART (học desktop session-sync.ts) ----
    // Không còn "đoán snapshot hay delta" trên một chuỗi text chung:
    // chìa là part.id. Snapshot (part.updated) = upsert thay thế; delta =
    // nối vào buffer, flush theo frame. Không có id (engine cũ) thì lùi về
    // heuristic nối chữ cũ cho an toàn.

    /** Nhét part (snapshot cộng dồn) vào message theo partId. */
    const applyPartSnapshot = (messageId, part) => {
      if (!messageId || !part?.id) return false;
      const prev = messagesRef.current ?? [];
      const list = [...prev];
      let idx = list.findIndex((m) => (m.info?.id ?? m.id) === messageId);
      if (idx < 0) {
        // Part mới của message mới — stub assistant, role thật sẽ đến theo
        // message.updated (desktop: inferStubRole).
        list.push({ info: { id: messageId, role: "assistant", time: { created: Date.now() } }, parts: [] });
        idx = list.length - 1;
      }
      const msg = list[idx];
      const parts = [...(msg.parts ?? [])];
      const pi = parts.findIndex((p) => p?.id === part.id);
      // Buffer delta và snapshot là hai góc nhìn cộng dồn của cùng một
      // stream — lấy cái DÀI HƠN, không nối (nối là nhân đôi bytes).
      const buffered = pendingDelta.current.get(part.id) ?? "";
      const base = typeof part.text === "string" ? part.text : "";
      const text = base.length >= buffered.length ? base : buffered;
      pendingDelta.current.delete(part.id);
      const merged = { ...(pi >= 0 ? parts[pi] : {}), ...part, text };
      if (pi >= 0) parts[pi] = merged;
      else parts.push(merged);
      list[idx] = { ...msg, parts };
      commitMessages(list);
      return true;
    };

    /** Heuristic cũ — fallback khi part không có id (engine cũ/bản lạ). */
    const applyTextPatch = (messageId, chunk) => {
      if (!chunk) return;
      const prev = messagesRef.current ?? [];
      const list = [...prev];
      let idx = -1;
      if (messageId) idx = list.findIndex((m) => (m.info?.id ?? m.id) === messageId);
      if (idx < 0) {
        for (let i = list.length - 1; i >= 0; i--) {
          if ((list[i].info?.role ?? list[i].role) === "assistant") {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) {
        list.push({
          info: { id: messageId || `stream-${Date.now()}`, role: "assistant", time: { created: Date.now() } },
          parts: [{ type: "text", text: chunk }],
        });
        commitMessages(list);
        return;
      }
      const msg = { ...list[idx], parts: [...(list[idx].parts ?? [])] };
      let pIdx = -1;
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        if (msg.parts[i]?.type === "text") {
          pIdx = i;
          break;
        }
      }
      if (pIdx < 0) {
        msg.parts = [...msg.parts, { type: "text", text: chunk }];
      } else {
        const cur = msg.parts[pIdx]?.text ?? "";
        let next;
        if (!cur) next = chunk;
        else if (chunk.startsWith(cur)) next = chunk; // snapshot full
        else if (cur.endsWith(chunk)) next = cur; // event phát lại đuôi cũ
        else next = cur + chunk; // delta
        msg.parts[pIdx] = { ...msg.parts[pIdx], text: next };
      }
      list[idx] = msg;
      commitMessages(list);
    };

    /** Upsert nguyên message từ message.updated (snapshot info + parts). */
    const applyMessageSnapshot = (messageId, info, parts) => {
      if (!messageId) return;
      const prev = messagesRef.current ?? [];
      const list = [...prev];
      const idx = list.findIndex((m) => (m.info?.id ?? m.id) === messageId);
      const clean = Array.isArray(parts) ? parts.filter(Boolean) : [];
      if (idx < 0) {
        list.push({ info: info ?? { id: messageId, role: "assistant" }, parts: clean });
        commitMessages(list);
        return;
      }
      // Parts rỗng không đè phần đang stream — info thì cứ cập nhật.
      list[idx] = {
        ...list[idx],
        info: info ?? list[idx].info,
        parts: clean.length ? clean : list[idx].parts,
      };
      commitMessages(list);
    };

    const removeMessage = (messageId) => {
      if (!messageId) return;
      const prev = messagesRef.current ?? [];
      commitMessages(prev.filter((m) => (m.info?.id ?? m.id) !== messageId));
    };

    /** Gom delta theo partId; part chưa khai báo thì giữ chờ seed từ
     * message.part.updated (đúng desktop pendingDeltas). */
    const queueDelta = (partId, delta) => {
      pendingDelta.current.set(partId, (pendingDelta.current.get(partId) ?? "") + delta);
      if (flushRef.current != null) return;
      // Foreground flush theo frame như desktop; không rAF thì 50ms.
      const run = () => {
        flushRef.current = null;
        flushDeltas();
      };
      flushRef.current =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(run)
          : setTimeout(run, 50);
    };

    const flushDeltas = () => {
      if (!pendingDelta.current.size) return;
      const prev = messagesRef.current;
      if (!prev) return; // chưa có snapshot — đợi part.updated seed
      const list = prev.map((msg) => {
        let parts = null;
        (msg.parts ?? []).forEach((p, i) => {
          if (!p?.id) return;
          const add = pendingDelta.current.get(p.id);
          if (!add) return;
          if (!parts) parts = [...msg.parts];
          parts[i] = { ...p, text: (p.text ?? "") + add };
        });
        return parts ? { ...msg, parts } : msg;
      });
      // Xoá delta của part đã khai báo; part chưa khai báo giữ lại đợi seed.
      const declared = new Set();
      for (const msg of prev) for (const p of msg.parts ?? []) if (p?.id) declared.add(p.id);
      for (const [partId] of [...pendingDelta.current]) {
        if (declared.has(partId)) pendingDelta.current.delete(partId);
      }
      commitMessages(list);
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
      }, 500);
    };

    const es = new EventSource(sseUrl(`${base}/event`));
    // Hạt nhân dispatch: engine v1 phát event KHÔNG TÊN trên SSE (data:
    // {"type":"message.part.delta",...}) — type nằm trong JSON. Named events
    // chỉ là đường phụ của một số bản engine, nên cả hai đều về handleEvent.
    const handleEvent = (name, data) => {
      lastEventAt.current = Date.now();
      if (!data || typeof data !== "object") return;
      if (!sameSession(eventSessionId(data), sessionId)) return;
      const props = eventProps(data);
      if (name === "message.part.updated") {
        const part = props.part && typeof props.part === "object" ? props.part : props;
        const ok = applyPartSnapshot(eventMessageId(data), part);
        if (!ok) {
          // Part không có id — heuristic nối chữ (engine cũ).
          const chunk =
            (typeof part?.text === "string" && part.text) ||
            (typeof props?.delta === "string" && props.delta) ||
            "";
          applyTextPatch(eventMessageId(data), chunk);
        }
        setRunning(true); // vào guồng stream ngay, poll dự phòng bám theo
        scheduleStatus();
        return;
      }
      if (name === "message.part.delta") {
        const partId = props.partID ?? props.partId ?? props.id;
        const delta = typeof props.delta === "string" ? props.delta : "";
        if (partId && delta) {
          queueDelta(partId, delta);
          setRunning(true);
        }
        scheduleStatus();
        return;
      }
      if (name === "message.updated") {
        const message = data.message ?? data.properties?.message ?? null;
        if (message) {
          applyMessageSnapshot(message.id ?? eventMessageId(data), message.info, message.parts);
          if (message.info?.role === "assistant" && message.parts?.some((p) => p?.type === "text")) {
            setRunning(true);
          }
        }
        scheduleStatus();
        return;
      }
      if (name === "message.removed") {
        removeMessage(props.messageID ?? props.messageId ?? props.id);
        return;
      }
      if (name === "session.idle" || name === "session.errored" || name === "session.status") {
        // Run kết thúc thật (idle/errored) hoặc status report — chốt ngay,
        // không chờ poll 2.5s. status mang map {ses: {type}} thì tự suy.
        const type = name === "session.status" ? props?.[sessionId]?.type ?? props?.[`ses_${sessionId}`]?.type : null;
        if (name === "session.idle") setRunning(false);
        else if (name === "session.errored") setRunning(false);
        else if (type) setRunning(type === "busy" || type === "retry");
        scheduleStatus();
        return;
      }
      if (name === "permission.updated") loadPermissions();
      scheduleOther();
    };
    const parseAndHandle = (name, event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {}
      handleEvent(name, data);
    };
    for (const name of SSE_EVENTS) es.addEventListener(name, (e) => parseAndHandle(name, e));
    es.onmessage = (e) => {
      // Dòng unnamed — bóc type từ JSON rồi dispatch đúng nhánh.
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {}
      handleEvent(typeof data?.type === "string" && data.type !== "server.connected" && data.type !== "server.heartbeat" ? data.type : "message", data);
    };
    es.onopen = () => {
      lastEventAt.current = Date.now();
      flushQueue();
    };
    // SSE chết ngầm (tunnel đổi, mobile ngủ, server restart) thì trình duyệt
    // tự nối lại — hỏi lại ngay để khỏi đứng hình chờ event tiếp theo.
    es.onerror = () => {
      loadMessages();
      loadStatus();
    };
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
      pendingDelta.current.clear();
      es.close();
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
    // Trang cuộn trên window (không có khung cuộn riêng) — chỉ bám đáy khi
    // user đang đọc cuối, đang lội lên trên thì không giật.
    const gap = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    if (gap > 260) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function modelBody() {
    // Đọc qua modelRef (không phải state): hàm này chạy cả trong flushQueue —
    // listener đóng từ effect setup lúc mount, state mới không chạm tới được.
    const current = modelRef.current;
    if (!current || !current.includes("/")) return undefined;
    const [providerID, modelID] = current.split("/");
    return { providerID, modelID };
  }

  // Nút gửi morph thành nút dừng khi agent đang chạy (như ChatGPT/Gemini):
  // ưu tiên phase upload (sending) để tránh bấm nhầm giữa chừng tải file.
  const busy = running && !sending;

  async function send() {
    const text = draft.trim();
    if ((!text && !attached.length) || sending || running) return;
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
      ? `File đính kèm từ điện thoại (đã lưu trong workspace):\n${uploaded.map((p) => `- ${p}`).join("\n")}\n`
      : "";
    const fullText = fileBlock + (text ? `\n${text}` : "\nHãy đọc các file đính kèm trên và xử lý.");
    const optimisticText = uploaded.length && !text
      ? `Đã gửi ${uploaded.length} file đính kèm.`
      : fullText;
    setDraft("");
    setAttached([]);
    // hiển thị ngay tin user (optimistic) — qua commit để messagesRef khớp
    commitMessages([
      ...(messagesRef.current ?? []),
      { info: { id: `local-${Date.now()}`, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text: optimisticText }] },
    ]);
    try {
      await ow(`${base}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: { parts: [{ type: "text", text: fullText }], ...(modelBody() ? { model: modelBody() } : {}) },
      });
      loadMessages();
      loadStatus();
    } catch {
      queueRef.current = [...queueRef.current, fullText]; // offline queue
      setQueueCount(queueRef.current.length);
      setError("Mất kết nối - tin nhắn sẽ tự gửi lại khi có mạng.");
    } finally {
      setSending(false);
    }
    if (failed) setError("Có file tải lên lỗi — agent chỉ thấy các file đã tải xong.");
  }

  function pickFiles(fileList) {
    const fresh = [...fileList].map((file) => ({ file, path: "", status: "ready", error: "" }));
    setAttached((prev) => [...prev, ...fresh].slice(0, 5));
  }

  async function abort() {
    if (aborting) return; // chống double-tap
    setAborting(true);
    try {
      await ow(`${base}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
      loadStatus();
      loadMessages();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setAborting(false);
    }
  }

  async function replyPermission(permission, response) {
    const pid = permission.id ?? permission.requestID;
    const candidates = response === "allow" ? ["allow", "once", "always"] : ["deny"];
    let lastError = "";
    for (const value of candidates) {
      try {
        await ow(`${base}/permission/${encodeURIComponent(pid)}/reply`, {
          method: "POST",
          body: { response: value },
        });
        setPermissions((prev) => prev.filter((p) => p !== permission));
        loadMessages();
        return;
      } catch (e) {
        lastError = String(e.message || e);
      }
    }
    setError(`Không trả lời được permission: ${lastError}`);
  }

  return (
    <>
      {error && <div class="banner err" role="alert" aria-live="polite"><span>{error}</span></div>}

      {permissions.map((p) => (
        <div class="permission-card" key={p.id ?? p.requestID}>
          <b>Agent xin phép</b>
          <div style="margin-top:6px" class="mono">
            {p.title ?? p.pattern ?? JSON.stringify(p).slice(0, 160)}
          </div>
          <div class="actions">
            <button class="btn small" onClick={() => replyPermission(p, "allow")}>
              Cho phép
            </button>
            <button class="btn small danger" onClick={() => replyPermission(p, "deny")}>
              Từ chối
            </button>
          </div>
        </div>
      ))}

      <div class="chat-list">
        {messages === null && <Loading />}
        {messages?.length === 0 && (
          <Empty title="Session trống" hint="Gửi prompt đầu tiên cho agent nhé." />
        )}
        {messages?.map((m, i) => (
          <MessageBubble key={m.info?.id ?? m.id ?? `msg-${i}`} message={m} wsId={wsId} />
        ))}
        {/* Dòng trạng thái DUY NHẤT phát ngôn cho screen reader (aria-live):
            trước đây thuộc tính này bọc TOÀN BỘ list tin nhắn — mỗi delta stream
            là đọc lại cả transcript. Vừa làm chỉ báo hàng đợi offline:
            "Đang gửi lại (n)" — hiện duy nhất khi có tin chờ/tác vụ chạy. */}
        <div class="msg assistant chat-status" role="status" aria-live="polite">
          {running && (
            <>
              <span class="spinner" /> agent đang chạy…
            </>
          )}
          {queueCount > 0 && (
            <>
              {running ? " · " : ""}Đang gửi lại {queueCount} tin nhắn khi có mạng…
            </>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <div class="composer">
        <div style="flex:1;min-width:0">
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
          <div style="display:flex;gap:8px">
            <button
              class="btn btn-send"
              style="background:var(--bg-raised);color:var(--text)"
              aria-label="Đính kèm file từ điện thoại"
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
              aria-label="Nhập prompt cho agent"
              placeholder={busy ? "Agent đang chạy… gõ tiếp câu mới, bấm ■ để dừng" : "Nhập prompt cho agent…"}
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (busy) abort();
                  else send();
                }
              }}
            />
            {busy ? (
              <button
                class="btn btn-send stop"
                aria-label="Dừng agent"
                title="Dừng agent"
                disabled={aborting}
                onClick={abort}
              >
                <StopIcon size={20} />
              </button>
            ) : (
              <button class="btn btn-send" aria-label="Gửi prompt" disabled={(!draft.trim() && !attached.length) || sending} onClick={send}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m22 2-7 20-4-9-9-4z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            )}
          </div>
          {attached.length > 0 && (
            <div class="attach-list">
              {attached.map((a, i) => (
                <span class="attach-chip" key={i}>
                  <span class="name">{a.file.name}</span>
                  <span class="size">
                    {a.status === "uploading" ? "đang tải…" : a.status === "error" ? "lỗi" : formatBytes(a.file.size)}
                  </span>
                  <button aria-label={`Gỡ ${a.file.name}`} onClick={() => setAttached((prev) => prev.filter((x) => x !== a))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MessageBubble({ message, wsId }) {
  // Shape engine: {info:{id,role,time,...}, parts:[...]} - fallback cho cả shape phẳng
  const role = message.info?.role ?? message.role;
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const files = role === "assistant" ? collectFileRefs(parts) : [];
  return (
    <div class={`msg ${role}`}>
      {parts.map((part, i) => {
        if (part.type === "text") {
          return <MarkdownText key={i} text={part.text} plain={role === "user"} wsId={wsId} />;
        }
        if (part.type === "tool") {
          const status = part.state?.status ?? "";
          return (
            <span class="tool-chip" key={i}>
              {part.tool ?? "tool"}{status ? ` · ${status}` : ""}
            </span>
          );
        }
        if (part.type === "reasoning" && part.text) {
          return (
            <details class="reasoning" key={i}>
              <summary>Suy luận</summary>
              <div class="reasoning-body">{part.text}</div>
            </details>
          );
        }
        return null;
      })}
      {files.map((f) => (
        <FileRefCard key={f.path} refPath={f.path} name={f.name} wsId={wsId} />
      ))}
    </div>
  );
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

/** Thẻ file trong chat: bấm để xem/tải ngay, không cần mò sang tab Files. */
function FileRefCard({ refPath, name, wsId }) {
  const [checking, setChecking] = useState(false);
  const [missing, setMissing] = useState(false);
  const base = `/workspace/${encodeURIComponent(wsId)}`;

  // Agent hay nhắc đường dẫn tuyệt đối Windows (C:\...), còn API file hiểu
  // đường dẫn tương đối trong workspace — thử cả hai, cái nào có thì dùng.
  function candidates() {
    const out = [refPath];
    const m = /^[A-Za-z]:[\\/]/.exec(refPath);
    if (m) out.push(refPath.slice(2).replace(/\\/g, "/").replace(/^\/+/, ""));
    return out;
  }

  async function open() {
    setChecking(true);
    setMissing(false);
    try {
      let found = "";
      for (const p of candidates()) {
        try {
          await ow(`${base}/files/stat?path=${encodeURIComponent(p)}`);
          found = p;
          break;
        } catch {
          /* thử ứng viên tiếp theo */
        }
      }
      if (!found) {
        setMissing(true);
        return;
      }
      // Mở tab mới để giữ nguyên trang chat (PWA không bị mất chỗ).
      window.open(sseUrl(`${base}/files/raw?path=${encodeURIComponent(found)}`), "_blank", "noopener");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div class="file-ref">
      <span class="file-ref-ico" aria-hidden="true"><FileIcon size={16} /></span>
      <span class="file-ref-name">{name}</span>
      <button class="btn small ghost" disabled={checking} onClick={open}>
        {checking ? "Đang mở…" : "Mở"}
      </button>
      <a
        class="btn small ghost file-ref-dir"
        style="text-decoration:none"
        aria-label="Xem trong Files"
        title="Xem trong Files"
        href={`#/ws/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(dirOf(refPath))}`}
      >
        <ExpandIcon size={15} />
      </a>
      {missing && <span class="file-ref-miss">Không thấy file này trong workspace (có thể agent ghi chỗ khác).</span>}
    </div>
  );
}

function dirOf(p) {
  const clean = String(p).replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "" : clean.slice(0, i);
}

/** Markdown tối giản cho bubble assistant (không thêm dep): code block,
 *  inline code, list gạch đầu dòng, xuống dòng. Tin user giữ text thuần.
 *  Đường dẫn file agent nhắc tới thành link bấm để tải/mở ngay. */
function MarkdownText({ text, plain, wsId }) {
  if (plain || !text) return <span class="msg-text">{text}</span>;
  const blocks = String(text).split(/```/);
  return (
    <span class="msg-md">
      {blocks.map((block, i) => {
        if (i % 2 === 1) return <pre key={i}><code>{block.replace(/^\w+\n/, "")}</code></pre>;
        return (
          <span key={i}>
            {block.split("\n").map((line, j) => {
              const trimmed = line.trim();
              if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                return <span key={j}>• {renderInline(trimmed.slice(2), wsId)}<br /></span>;
              }
              if (/^\d+[.)] /.test(trimmed)) {
                return <span key={j}>{renderInline(line, wsId)}<br /></span>;
              }
              return line ? <span key={j}>{renderInline(line, wsId)}<br /></span> : <br key={j} />;
            })}
          </span>
        );
      })}
    </span>
  );
}

/** Inline code `...` trong một dòng + link hóa đường dẫn file (không thêm dep). */
function renderInline(line, wsId) {
  const chunks = String(line).split("`");
  if (chunks.length === 1) return linkifyFiles(line, wsId);
  return chunks.map((chunk, i) =>
    i % 2 === 1 ? <code key={i}>{chunk}</code> : <span key={i}>{linkifyFiles(chunk, wsId)}</span>
  );
}

/** Biến đường dẫn file trong text thường thành link Mở / Tải về. */
function linkifyFiles(text, wsId) {
  if (!wsId) return text;
  const refs = findFileRefsInText(text);
  if (!refs.length) return text;
  const parts = [];
  let rest = String(text);
  let k = 0;
  for (const ref of refs) {
    const at = rest.indexOf(ref.path);
    if (at < 0) continue;
    if (at > 0) parts.push(<span key={k++}>{rest.slice(0, at)}</span>);
    parts.push(
      <a
        key={k++}
        href={sseUrl(`/workspace/${encodeURIComponent(wsId)}/files/raw?path=${encodeURIComponent(ref.path)}`)}
        target="_blank"
        rel="noreferrer"
      >
        {ref.path}
      </a>
    );
    rest = rest.slice(at + ref.path.length);
  }
  if (rest) parts.push(<span key={k++}>{rest}</span>);
  return parts;
}
