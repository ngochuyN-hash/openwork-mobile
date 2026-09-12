import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { ow, unwrap, sseUrl, getToken } from "../api.js";
import { navigate } from "../app.jsx";
import { BackButton, Banner, Empty, Loading } from "../components/ui.jsx";

const SSE_EVENTS = [
  "session.updated",
  "session.deleted",
  "session.errored",
  "message.updated",
  "message.part.updated",
  "permission.updated",
  "connection.updated",
];

export function ChatPage({ route }) {
  const { wsId, sessionId } = route;
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState(null);
  const [running, setRunning] = useState(false);
  const [permissions, setPermissions] = useState([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState([]); // [{value:'provider/model', label}]
  const [model, setModel] = useState(() => localStorage.getItem("owm_model") ?? "");
  const queueRef = useRef([]);
  const bottomRef = useRef(null);
  const draftRef = useRef("");
  draftRef.current = draft;

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
      setMessages(unwrap(payload) ?? []);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [wsId, sessionId]);

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
      setPermissions(list.filter((p) => !p.sessionID || p.sessionID === sessionId));
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
        queueRef.current.shift();
      } catch {
        return; // vẫn mất mạng - giữ lại lần sau
      }
    }
    loadMessages();
    loadStatus();
  }, [wsId, sessionId]);

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
            flat.push({ value: `${p.id}/${m.id}`, label: `${p.name} · ${m.name ?? m.id}` });
          }
        }
        setModels(flat);
        if (!localStorage.getItem("owm_model") && flat.length) {
          localStorage.setItem("owm_model", flat[0].value);
          setModel(flat[0].value);
        }
      })
      .catch(() => {});

    let timer = null;
    const scheduleMessages = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        loadMessages();
        loadStatus();
      }, 500);
    };

    const es = new EventSource(sseUrl(`${base}/event`));
    const onEvent = (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {}
      if (!data || data.sessionID === undefined || data.sessionID === sessionId) scheduleMessages();
    };
    for (const name of SSE_EVENTS) es.addEventListener(name, onEvent);
    es.onmessage = onEvent; // event không có tên
    es.onopen = () => flushQueue();
    const onOnline = () => flushQueue();
    window.addEventListener("online", onOnline);

    return () => {
      clearTimeout(timer);
      es.close();
      window.removeEventListener("online", onOnline);
    };
  }, [wsId, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages?.length]);

  function modelBody() {
    if (!model || !model.includes("/")) return undefined;
    const [providerID, modelID] = model.split("/");
    return { providerID, modelID };
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    // hiển thị ngay tin user (optimistic)
    setMessages((prev) => [
      ...(prev ?? []),
      { info: { id: `local-${Date.now()}`, role: "user", time: { created: Date.now() } }, parts: [{ type: "text", text }] },
    ]);
    setSending(true);
    try {
      await ow(`${base}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: { parts: [{ type: "text", text }], ...(modelBody() ? { model: modelBody() } : {}) },
      });
      loadMessages();
      loadStatus();
    } catch {
      queueRef.current.push(text); // offline queue
      setError("Mất kết nối - tin nhắn sẽ tự gửi lại khi có mạng.");
    } finally {
      setSending(false);
    }
  }

  async function abort() {
    try {
      await ow(`${base}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
      loadStatus();
      loadMessages();
    } catch (e) {
      setError(String(e.message || e));
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
      <div class="page-head">
        <BackButton label="Sessions" onBack={() => navigate(`#/ws/${encodeURIComponent(wsId)}`)} />
        {running && (
          <button class="btn small danger" onClick={abort}>
            Dừng agent
          </button>
        )}
      </div>

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

      <div class="chat-list" aria-live="polite">
        {messages === null && <Loading />}
        {messages?.length === 0 && (
          <Empty title="Session trống" hint="Gửi prompt đầu tiên cho agent nhé." />
        )}
        {messages?.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {running && (
          <div class="msg assistant">
            <span class="spinner" /> agent đang chạy…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div class="composer">
        <div style="flex:1;min-width:0">
          {models.length > 0 && (
            <select
              class="model-picker"
              aria-label="Chọn model cho agent"
              value={model}
              onChange={(e) => {
                setModel(e.currentTarget.value);
                localStorage.setItem("owm_model", e.currentTarget.value);
              }}
            >
              {models.map((m) => (
                <option value={m.value}>{m.label}</option>
              ))}
            </select>
          )}
          <div style="display:flex;gap:8px">
            <textarea
              placeholder="Nhập prompt cho agent…"
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button class="btn" disabled={!draft.trim() || sending} onClick={send}>
              {sending ? "…" : "Gửi"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function MessageBubble({ message }) {
  // Shape engine: {info:{id,role,time,...}, parts:[...]} - fallback cho cả shape phẳng
  const role = message.info?.role ?? message.role;
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return (
    <div class={`msg ${role}`}>
      {parts.map((part, i) => {
        if (part.type === "text") return <MarkdownText key={i} text={part.text} plain={role === "user"} />;
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
            <span class="tool-chip" key={i}>
              {part.text.slice(0, 140)}
              {part.text.length > 140 ? "…" : ""}
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}

/** Markdown tối giản cho bubble assistant (không thêm dep): code block,
 *  inline code, list gạch đầu dòng, xuống dòng. Tin user giữ text thuần. */
function MarkdownText({ text, plain }) {
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
                return <span key={j}>• {renderInline(trimmed.slice(2))}<br /></span>;
              }
              if (/^\d+[.)] /.test(trimmed)) {
                return <span key={j}>{renderInline(line)}<br /></span>;
              }
              return line ? <span key={j}>{renderInline(line)}<br /></span> : <br key={j} />;
            })}
          </span>
        );
      })}
    </span>
  );
}

/** Inline code `...` trong một dòng (không thêm dep). */
function renderInline(line) {
  const chunks = String(line).split("`");
  if (chunks.length === 1) return line;
  return chunks.map((chunk, i) => (i % 2 === 1 ? <code key={i}>{chunk}</code> : <span key={i}>{chunk}</span>));
}
