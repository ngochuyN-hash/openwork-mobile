import { useEffect, useRef, useState } from "preact/hooks";
import { ow, unwrap, timeAgo, sseUrl } from "../api.js";
import { navigate } from "../app.jsx";
import { PlusIcon } from "../components/icons.jsx";
import { BackButton, Banner, Empty, SkeletonList } from "../components/ui.jsx";

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
        // Không gửi title — để server tự sinh tên theo nội dung như desktop.
        body: {},
      });
      const created = unwrap(payload);
      if (created?.id) navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(created.id)}`);
      else load();
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  return (
    <>
      <div class="page-head">
        <BackButton label="Workspace" onBack={() => navigate("#/workspaces")} />
      </div>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={load}>{error}</Banner>}

      {sessions === null && !error && <SkeletonList rows={3} />}

      {sessions?.length === 0 && (
        <Empty
          icon
          title="Chưa có session nào"
          hint="Bấm nút (+) để bắt đầu trò chuyện với agent."
          actionLabel="Tạo session mới"
          onAction={newSession}
        />
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
              <h3>{s.title || "Không tiêu đề"}</h3>
              <span class={`dot ${status === "busy" ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
            </div>
            <div class="meta">{timeAgo(s.time?.updated)}</div>
          </div>
        );
      })}

      <button class="fab" aria-label="Tạo session mới" onClick={newSession}>
        <PlusIcon size={24} />
      </button>
    </>
  );
}
