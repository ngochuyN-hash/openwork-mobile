import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, owDeleteSession } from "../api.js";
import { timeAgo, unwrap, wsColor } from "../lib/format.js";
import { errorSentence } from "../lib/net.js";
import { createLoadGuard } from "../lib/load-guard.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList, SwipeRow } from "../components/ui.jsx";
import { SearchIcon } from "../components/icons.jsx";
import { sessionTitleOf } from "../lib/session-rename.js";
import {
  // Xoá kiểu lạc quan (vòng đời + phần thuần) + nhận diện "đang chạy" —
  // luật thuần ở lib/session-ops.js để node --test khoá được.
  createOptimisticRemove,
  dropSessionItem,
  isSessionBusy,
  mergeHomeFeed,
} from "../lib/session-ops.js";

/** Home = danh sách session gần đây GỘP từ mọi workspace
 *  (pattern Happy/Omnara: mở app là thấy session, không phải list workspace). */
export function HomePage() {
  const [items, setItems] = useState(null); // [{ws, session}]
  const [statuses, setStatuses] = useState({}); // key `${wsId}:${sid}` -> type
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null); // key `${wsId}:${sid}` — 1 dòng vuốt mở / lúc
  const timerRef = useRef(null);
  // Chống race (lib/load-guard — một primitive chung với files/search/sessions):
  // poll 15s vừa bắt đầu thì người dùng bấm "Thử lại", hoặc vuốt xoá xong lại
  // load — lượt cũ về sau không được ghi đè lượt mới, và request thừa bị hủy
  // (mỗi lượt là 8 workspace x 2 call — tốn băng thông điện thoại).
  const guardRef = useRef(null);
  if (!guardRef.current) guardRef.current = createLoadGuard();
  const itemsRef = useRef(null); // bản sao mới nhất, để hoàn tác xoá lạc quan
  itemsRef.current = items;
  // Vòng đời xoá lạc quan (khoá vuốt-hai-lần + hoàn-tác-có-điều-kiện) — dùng
  // chung với sessions.jsx, trước đây chép tay hai nơi.
  const removerRef = useRef(null);
  if (!removerRef.current) removerRef.current = createOptimisticRemove();

  const load = useCallback(async () => {
    const token = guardRef.current.begin();
    const stale = () => guardRef.current.stale(token);
    try {
      const payload = await ow("/workspaces", { signal: token.signal });
      if (stale()) return;
      const wss = unwrap(payload)?.workspaces ?? payload?.workspaces ?? [];
      const slice = wss.slice(0, 8);
      const [sessRes, statRes] = await Promise.allSettled([
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session`, { signal: token.signal })
              .then((p) => (unwrap(p) ?? []).map((s) => ({ ws, session: s })))
              .catch(() => [])
          )
        ),
        Promise.all(
          slice.map((ws) =>
            ow(`/workspace/${encodeURIComponent(ws.id)}/opencode/session/status`, { signal: token.signal })
              .then((p) => ({ wsId: ws.id, map: unwrap(p) ?? p ?? {} }))
              .catch(() => null)
          )
        ),
      ]);
      if (stale()) return;
      const groups = sessRes.status === "fulfilled" ? sessRes.value : [];
      // Ghép + sort + slice 30 + map trạng thái nằm ở lib/session-ops (thuần,
      // test được). Lượt status hỏng thì GIỮ map cũ — chấm "đang chạy" không
      // tắt oan chỉ vì một lượt poll lỗi.
      const statResults = statRes.status === "fulfilled" ? statRes.value : [];
      const { items: merged, statuses: next } = mergeHomeFeed(groups, statResults);
      setItems(merged);
      setError("");
      if (statRes.status === "fulfilled") setStatuses(next);
    } catch (e) {
      if (stale() || e?.name === "AbortError") return;
      // KHÔNG xoá sạch danh sách khi một lượt poll hỏng: máy tính ngủ hoặc
      // rớt mạng giữa lúc app mở là Home trắng bệch "Chưa có session nào",
      // người dùng tưởng mất sạch phiên. Giữ danh sách cũ, chỉ báo lỗi.
      setError(errorSentence(e));
      if (itemsRef.current === null) setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000); // home poll nhẹ (SSE chỉ ở trong workspace)
    return () => {
      guardRef.current.invalidate(); // mọi token thành stale + hủy fetch — đừng vẽ vào màn đã đóng
      clearInterval(timerRef.current);
    };
  }, [load]);

  const busyCount =
    items?.filter((it) => isSessionBusy(statuses[`${it.ws.id}:${it.session.id}`])).length ?? 0;

  // Danh sách hiện = toàn bộ phiên gần đây theo thứ tự thời gian.
  const shown = items;

  /**
   * Xoá phiên bằng cử chỉ vuốt: vòng đời (chặn xoá hai lần, mất dòng ngay,
   * hoàn tác CHỈ khi chưa có load() mới về đè) nằm ở lib/session-ops
   * createOptimisticRemove — dùng chung với sessions.jsx, trước đây chép tay
   * hai nơi và home sống sót nhờ chép đúng ba bug cũ.
   */
  function remove(ws, session) {
    setOpenId(null);
    const sid = String(session?.id ?? "");
    const wsId = String(ws?.id ?? "");
    removerRef.current.remove(
      `${wsId}:${sid}`,
      [{ ref: itemsRef, drop: (list) => dropSessionItem(list, wsId, sid), commit: setItems }],
      () => owDeleteSession(wsId, sid),
      {
        onDone: () => {
          setError("");
          load();
        },
        onFail: (e) => setError(`Failed to delete this session: ${errorSentence(e)}`),
      }
    );
  }

  return (
    <>
      <div class="page-head">
        <span class="hint">
          {items
            ? `${shown.length} session${busyCount ? ` · ${busyCount} running` : ""}`
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

      {shown?.map(({ ws, session }) => {
        const status = statuses[`${ws.id}:${session.id}`];
        const key = `${ws.id}:${session.id}`;        return (
          <SwipeRow
            key={key}
            open={openId === key}
            requestOpen={(v) => setOpenId(v ? key : null)}
            onAction={() => remove(ws, session)}
            onTap={() => navigate(`#/ws/${encodeURIComponent(ws.id)}/chat/${encodeURIComponent(session.id)}`)}
          >
            <div
              class="card tap dense"
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
                  <span class={`dot ${isSessionBusy(status) ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
                </div>
              </div>
              <div class="row-between">
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
