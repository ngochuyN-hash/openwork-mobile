import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { ow, unwrap, sseUrl, owUploadFile, formatBytes } from "../api.js";
import { connectEvents } from "../lib/sse.js";
import { createChatStream, mergeRefetchKeepInflight } from "../lib/chat-stream.js";
import { Banner, Empty, Loading } from "../components/ui.jsx";
import { ModelPicker, pushRecentModel } from "../components/model-picker.jsx";
import { ClipIcon, FileIcon, StopIcon, ToolIcon, ThoughtIcon, ChevronDownIcon } from "../components/icons.jsx";

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
  // Reducer stream (lib/chat-stream.js — thuần, có test) + lịch flush theo
  // frame: gom delta rồi đổ một lần, không re-render từng ký tự.
  const streamRef = useRef(null);
  if (!streamRef.current) streamRef.current = createChatStream();
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
      const fetched = unwrap(payload) ?? [];
      // Transcript API chỉ flush khi run XONG — giữa chừng fetched thiếu message
      // đang stream; thay nguyên list là trang co cụm, scroll bị hất ngược lên
      // (bug "cuộn xuống tự cuộn lên"). Đang chạy thì giữ message chưa ghi xong.
      commitMessages(
        runningRef.current ? mergeRefetchKeepInflight(fetched, messagesRef.current) : fetched
      );
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
        const type = name === "session.status" ? props?.[sessionId]?.type ?? props?.[`ses_${sessionId}`]?.type : null;
        if (name !== "session.status") setRunning(false);
        else if (type) setRunning(type === "busy" || type === "retry");
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
    // Stream qua fetch (lib/sse.js): token đi bằng header Authorization thay
    // vì ?_t= trên URL như EventSource cũ, đứt là tự nối lại với backoff.
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

const TOOL_STATUS_VI = {
  pending: "đang chờ",
  running: "đang chạy",
  completed: "xong",
  error: "lỗi",
};

function ToolRow({ part }) {
  const status = part.state?.status ?? "";
  const title = part.state?.title ?? part.tool ?? "tool";
  const input = part.state?.input;
  const output = typeof part.state?.output === "string" ? part.state.output : "";
  // Trần hiển thị: transcript tool có khi cả trăm KB — cắt bớt cho điện thoại.
  const MAX = 20_000;
  return (
    <details class="fold-row tool-row">
      <summary>
        <ToolIcon size={14} />
        <span class="fold-title">{title}</span>
        <span class={`fold-status${status === "error" ? " err" : ""}${status === "running" ? " run" : ""}`}>
          {TOOL_STATUS_VI[status] ?? status}
        </span>
        <ChevronDownIcon size={12} />
      </summary>
      <div class="fold-body">
        {input && Object.keys(input).length > 0 && <pre>{safeJson(input).slice(0, MAX)}</pre>}
        {output && <pre>{output.slice(0, MAX)}{output.length > MAX ? "\n… (cắt bớt)" : ""}</pre>}
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
        <span class="fold-title">Suy luận</span>
        <span class={`fold-status${streaming ? " run" : ""}`}>{streaming ? "đang suy nghĩ…" : ""}</span>
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
        aria-label={`Mở ${name} trong Files`}
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
          <span class="file-row-hint">đang mở…</span>
        ) : (
          <span class="file-row-chev" aria-hidden="true"><ChevronDownIcon size={12} /></span>
        )}
      </div>
      {missing && (
        <div class="file-row-miss">Không thấy file này trong workspace (có thể agent ghi chỗ khác).</div>
      )}
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
