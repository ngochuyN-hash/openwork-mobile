import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, owDeleteSession, unwrap, timeAgo } from "../api.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList, SwipeRow } from "../components/ui.jsx";

/** Màu chấm nhận diện workspace — hash id, đúng kiểu desktop (mỗi ws 1 màu). */
const WS_COLORS = ["#d6409f", "#30a46c", "#f76b15", "#0090ff", "#6e56cf", "#e2a336", "#12a594", "#e54666"];
export function wsColor(id = "") {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WS_COLORS[h % WS_COLORS.length];
}

/** Home = danh sách session gần đây GỘP từ mọi workspace
 *  (pattern Happy/Omnara: mở app là thấy session, không phải list workspace). */
export function HomePage() {
  const [items, setItems] = useState(null); // [{ws, session}]
  const [statuses, setStatuses] = useState({}); // key `${wsId}:${sid}` -> type
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null); // key `${wsId}:${sid}` — 1 dòng vuốt mở / lúc
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const payload = await ow("/workspaces");
      const wss = unwrap(payload)?.workspaces ?? payload?.workspaces ?? [];
      const slice = wss.slice(0, 8);
      const [sessRes, statRes] = await Promise.allSettled([
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session`)
              .then((p) => (unwrap(p) ?? []).map((s) => ({ ws, session: s })))
              .catch(() => [])
          )
        ),
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session/status`)
              .then((p) => ({ wsId: ws.id, map: unwrap(p) ?? p ?? {} }))
              .catch(() => null)
          )
        ),
      ]);
      const groups = sessRes.status === "fulfilled" ? sessRes.value : [];
      const merged = groups.flat().sort(
        (a, b) => (b.session.time?.updated ?? 0) - (a.session.time?.updated ?? 0)
      );
      setItems(merged.slice(0, 30));
      setError("");
      if (statRes.status === "fulfilled") {
        const next = {};
        for (const entry of statRes.value) {
          if (!entry) continue;
          for (const [sid, info] of Object.entries(entry.map)) {
            next[`${entry.wsId}:${sid}`] = info?.type;
          }
        }
        setStatuses(next);
      }
    } catch (e) {
      setError(String(e.message || e));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000); // home poll nhẹ (SSE chỉ ở trong workspace)
    return () => clearInterval(timerRef.current);
  }, [load]);

  async function newSession() {
    const target = items?.[0]?.ws;
    if (!target) return;
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(target.id)}/opencode/session`, {
        method: "POST",
        // Không gửi title — để server tự sinh tên theo nội dung như desktop.
        body: {},
      });
      const created = unwrap(payload);
      if (created?.id) navigate(`#/ws/${encodeURIComponent(target.id)}/chat/${encodeURIComponent(created.id)}`);
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  const busyCount = items?.filter((it) => statuses[`${it.ws.id}:${it.session.id}`] === "busy").length ?? 0;

  async function remove(ws, session) {
    setOpenId(null);
    try {
      await owDeleteSession(ws.id, session.id);
    } catch (e) {
      setError(String(e.message || e));
    }
    load();
  }

  return (
    <>
      <div class="page-head">
        <span class="hint">
          {items ? `${items.length} session${busyCount ? ` · ${busyCount} đang chạy` : ""}` : "…"}
        </span>
      </div>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={load}>{error}</Banner>}

      {items === null && !error && <SkeletonList rows={4} />}

      {items?.length === 0 && (
        <Empty
          icon
          title="Chưa có session nào"
          hint="Vào tab Workspace, chọn workspace rồi bấm (+) để tạo session đầu tiên."
        />
      )}

      {items?.map(({ ws, session }) => {
        const status = statuses[`${ws.id}:${session.id}`];
        const key = `${ws.id}:${session.id}`;
        return (
          <SwipeRow
            key={key}
            open={openId === key}
            requestOpen={(v) => setOpenId(v ? key : null)}
            onAction={() => remove(ws, session)}
            onTap={() => navigate(`#/ws/${encodeURIComponent(ws.id)}/chat/${encodeURIComponent(session.id)}`)}
          >
            <div class="card tap">
              <div class="row-between">
                <h3>{session.title || "Không tiêu đề"}</h3>
                <span class={`dot ${status === "busy" ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
              </div>
              <div class="row-between" style="margin-top:6px">
                <span class="ws-chip" style={`--ws-c:${wsColor(ws.id)}`}>
                  <span class="ws-dot" style={`background:${wsColor(ws.id)}`} aria-hidden="true" />
                  <span class="ws-name">{ws.name || ws.displayName || ws.id}</span>
                </span>
                <span class="hint">{timeAgo(session.time?.updated)}</span>
              </div>
            </div>
          </SwipeRow>
        );
      })}

      {items?.length > 0 && (
        <button class="fab" aria-label="Tạo session mới" onClick={newSession}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </>
  );
}