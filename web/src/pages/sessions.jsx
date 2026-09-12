import { useEffect, useRef, useState } from "preact/hooks";
import { ow, unwrap, timeAgo, sseUrl } from "../api.js";
import { navigate } from "../app.jsx";

export function SessionsPage({ route }) {
  const { wsId } = route;
  const [sessions, setSessions] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [error, setError] = useState("");
  const esRef = useRef(null);

  async function load() {
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session`);
      const list = unwrap(payload) ?? [];
      setSessions([...list].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)));
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function loadStatuses() {
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session/status`);
      const map = unwrap(payload) ?? payload ?? {};
      setStatuses(map);
    } catch {
      /* status là bonus - bỏ qua lỗi */
    }
  }

  useEffect(() => {
    load();
    loadStatuses();
    // SSE từ engine: session.updated/message.updated -> refresh (debounce)
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        load();
        loadStatuses();
      }, 700);
    };
    const es = new EventSource(sseUrl(`/workspace/${encodeURIComponent(wsId)}/opencode/event`));
    const onEvent = () => schedule();
    for (const name of ["session.updated", "session.deleted", "message.updated", "message.part.updated"]) {
      es.addEventListener(name, onEvent);
    }
    es.onmessage = onEvent;
    esRef.current = es;
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [wsId]);

  async function newSession() {
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session`, {
        method: "POST",
        body: { title: "Mobile" },
      });
      const created = unwrap(payload);
      if (created?.id) navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(created.id)}`);
      else load();
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  const sessionCount = sessions?.length ?? 0;

  return (
    <>
      <div class="row-between" style="margin-bottom:12px">
        <button class="btn small ghost" onClick={() => navigate("#/")}>
          ‹ Workspaces
        </button>
        <button class="btn small" onClick={newSession}>
          + Session mới
        </button>
      </div>

      {error && <div class="banner err"><span>{error}</span></div>}

      {sessions === null && !error && <div class="empty"><span class="spinner" /> Đang tải…</div>}

      {sessions?.length === 0 && (
        <div class="empty">
          Workspace này chưa có session nào.
          <br />
          Bấm “+ Session mới” để bắt đầu.
        </div>
      )}

      {sessions?.map((s) => {
        const status = statuses[s.id]?.type;
        return (
          <div
            key={s.id}
            class="card tap"
            onClick={() => navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(s.id)}`)}
          >
            <div class="row-between">
              <h3 style="flex:1;margin-right:8px">{s.title || "Không tiêu đề"}</h3>
              <span class={`badge ${status === "busy" ? "busy" : status ? "ok" : ""}`}>{status ?? ""}</span>
            </div>
            <div class="meta">
              {timeAgo(s.time?.updated)} · <span class="mono">{s.id}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
