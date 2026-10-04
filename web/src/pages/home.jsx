import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, owDeleteSession, unwrap, timeAgo } from "../api.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList, SwipeRow } from "../components/ui.jsx";
import { SearchIcon } from "../components/icons.jsx";
import {
  // Ghim / lưu trữ: cờ cục bộ của máy đang cầm (xem lib/session-organize.js).
  // Home là danh sách GỘP mọi workspace nên không có nhóm phiên ở đây — nhóm là
  // dữ liệu của từng workspace, chỉ màn trong workspace mới quản lý được.
  loadFlags,
  saveFlags,
  toggleFlag,
  flagOn,
} from "../lib/session-organize.js";
import { sessionTitleOf } from "../lib/session-rename.js";
import {
  // Xoá kiểu lạc quan + nhận diện "đang chạy" (luật thuần ở lib/session-ops.js).
  dropSessionItem,
  isSessionBusy,
} from "../lib/session-ops.js";
import { PinIcon } from "./sessions.jsx";

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
  const [flagMap, setFlagMap] = useState({}); // wsId -> {pinned, archived} (localStorage)
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null); // key `${wsId}:${sid}` — 1 dòng vuốt mở / lúc
  const timerRef = useRef(null);
  // Chống race (mẫu của pages/files.jsx:41-64): poll 15s vừa bắt đầu thì người
  // dùng bấm "Thử lại", hoặc vuốt xoá xong lại load — lượt cũ về sau không
  // được ghi đè lượt mới. `seq` cho từng lượt, `abort` để bỏ request thừa
  // (mỗi lượt là 8 workspace x 2 call — tốn băng thông điện thoại).
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const itemsRef = useRef(null); // bản sao mới nhất, để hoàn tác xoá lạc quan
  itemsRef.current = items;
  const deletingRef = useRef(new Set());
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const stale = () => !aliveRef.current || seq !== seqRef.current;
    try {
      const payload = await ow("/workspaces", { signal: ctrl.signal });
      if (stale()) return;
      const wss = unwrap(payload)?.workspaces ?? payload?.workspaces ?? [];
      const slice = wss.slice(0, 8);
      const [sessRes, statRes] = await Promise.allSettled([
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session`, { signal: ctrl.signal })
              .then((p) => (unwrap(p) ?? []).map((s) => ({ ws, session: s })))
              .catch(() => [])
          )
        ),
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session/status`, { signal: ctrl.signal })
              .then((p) => ({ wsId: ws.id, map: unwrap(p) ?? p ?? {} }))
              .catch(() => null)
          )
        ),
      ]);
      if (stale()) return;
      const groups = sessRes.status === "fulfilled" ? sessRes.value : [];
      const merged = groups.flat().sort(
        (a, b) => (b.session.time?.updated ?? 0) - (a.session.time?.updated ?? 0)
      );
      // Cờ ghim/lưu trữ nằm ở localStorage, đọc mỗi lần nạp để không phải
      // bắt sự kiện giữa các màn. Rẻ hơn một request.
      const flags = {};
      for (const ws of slice) flags[ws.id] = loadFlags(ws.id);
      setFlagMap(flags);
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
      if (stale() || e?.name === "AbortError") return;
      // KHÔNG xoá sạch danh sách khi một lượt poll hỏng: máy tính ngủ hoặc
      // rớt mạng giữa lúc app mở là Home trắng bệch "Chưa có session nào",
      // người dùng tưởng mất sạch phiên. Giữ danh sách cũ, chỉ báo lỗi.
      setError(String(e.message || e));
      if (itemsRef.current === null) setItems([]);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    timerRef.current = setInterval(load, 15_000); // home poll nhẹ (SSE chỉ ở trong workspace)
    return () => {
      aliveRef.current = false;
      clearInterval(timerRef.current);
      abortRef.current?.abort(); // đừng vẽ vào màn đã đóng
    };
  }, [load]);

  const busyCount =
    items?.filter((it) => isSessionBusy(statuses[`${it.ws.id}:${it.session.id}`])).length ?? 0;

  /** Cờ ghim/lưu trữ của workspace chứa phiên này. */
  const flagsOf = (wsId) => flagMap[wsId] ?? { pinned: [], archived: [] };
  const isPinned = (wsId, sid) => flagOn(flagsOf(wsId), "pinned", sid);
  const isHidden = (wsId, sid) => flagOn(flagsOf(wsId), "archived", sid);

  // Ghim lên đầu, còn lại giữ nguyên thứ tự thời gian; phiên đã lưu trữ thì
  // ẩm hẳn (xem lại được trong màn Sessions, mục "Lưu trữ").
  const shown = items
    ? [...items.filter((it) => isPinned(it.ws.id, it.session.id)), ...items.filter((it) => !isPinned(it.ws.id, it.session.id))].filter(
        (it) => !isHidden(it.ws.id, it.session.id)
      )
    : null;
  const pinnedCount = items?.filter((it) => isPinned(it.ws.id, it.session.id)).length ?? 0;

  /** Bật/tắt ghim cho một phiên — cờ lưu theo workspace của phiên đó. */
  function togglePin(ws, session) {
    const next = saveFlags(ws.id, toggleFlag(flagsOf(ws.id), "pinned", session.id));
    setFlagMap((prev) => ({ ...prev, [ws.id]: next }));
  }

  /**
   * Xoá phiên bằng cử chỉ vuốt — cùng ba lỗi đã sửa ở sessions.jsx:
   * chặn vuốt hai lần, mất dòng ngay (đỡ tay bấm tiếp tưởng chưa xoá), và
   * lỗi xoá KHÔNG bị `load()` ngay sau đó xoá mất (trước đây `load()` gọi
   * setError("") nên máy tính ngủ lúc vuốt là không có một chữ báo nào).
   */
  async function remove(ws, session) {
    setOpenId(null);
    const sid = String(session?.id ?? "");
    const wsId = String(ws?.id ?? "");
    const key = `${wsId}:${sid}`;
    if (!sid || deletingRef.current.has(key)) return;
    deletingRef.current.add(key);
    const before = itemsRef.current;
    const afterDrop = dropSessionItem(before, wsId, sid);
    setItems(afterDrop);
    try {
      await owDeleteSession(wsId, sid);
      setError("");
      load();
    } catch (e) {
      if (itemsRef.current === afterDrop) setItems(before);
      setError(`Failed to delete this session: ${e?.message || e}`);
    } finally {
      deletingRef.current.delete(key);
    }
  }

  return (
    <>
      <div class="page-head">
        <span class="hint">
          {items
            ? `${shown.length} session${pinnedCount ? ` · ${pinnedCount} pinned` : ""}${busyCount ? ` · ${busyCount} running` : ""}`
            : "…"}
        </span>
        <button type="button" class="btn small ghost" onClick={() => navigate("#/search")}>
          <SearchIcon size={16} /> Search sessions
        </button>
      </div>

      {error && <Banner kind="err" actionLabel="Retry" onAction={load}>{error}</Banner>}

      {items === null && !error && <SkeletonList rows={4} />}

      {items?.length === 0 && (
        <Empty
          icon
          title="No sessions yet"
          hint="Go to Workspace tab, select a workspace, and tap (+) to create your first session."
        />
      )}

      {items?.length > 0 && shown.length === 0 && (
        <Empty
          icon
          title="No sessions here"
          hint="All sessions are archived. Open a workspace to restore them."
        />
      )}

      {shown?.map(({ ws, session }) => {
        const status = statuses[`${ws.id}:${session.id}`];
        const pinned = isPinned(ws.id, session.id);
        const key = `${ws.id}:${session.id}`;        return (
          <SwipeRow
            key={key}
            open={openId === key}
            requestOpen={(v) => setOpenId(v ? key : null)}
            onAction={() => remove(ws, session)}
            onTap={() => navigate(`#/ws/${encodeURIComponent(ws.id)}/chat/${encodeURIComponent(session.id)}`)}
          >
            <div
              class="card tap"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(`#/ws/${encodeURIComponent(ws.id)}/chat/${encodeURIComponent(session.id)}`);
                }
              }}
            >
              <div class="row-between">
                <h3>{sessionTitleOf(session)}</h3>
                <div class="page-actions">
                  <button
                    type="button"
                    class="btn small ghost btn-icon"
                    aria-pressed={pinned}
                    aria-label={pinned ? "Unpin this session" : "Pin session to top"}
                    onClick={(e) => {
                      e.stopPropagation(); // nếu không, SwipeRow coi là tap -> mở phiên
                      togglePin(ws, session);
                    }}
                  >
                    <PinIcon size={16} filled={pinned} />
                  </button>
                  <span class={`dot ${isSessionBusy(status) ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
                </div>
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

    </>
  );
}
