import { useEffect, useRef, useState } from "preact/hooks";
import { ow, owDeleteSession } from "../api.js";
import { timeAgo, unwrap } from "../lib/format.js";
import { errorSentence } from "../lib/net.js";
import { connectEvents } from "../lib/sse.js";
import { OW_PROXY_PREFIX } from "../../../shared/contract.js";
import { createLoadGuard } from "../lib/load-guard.js";
import {
  // Xoá phiên + trạng thái đang chạy: luật thuần ở lib/session-ops.js để test
  // được. `dropSessionById` là phần "xoá kiểu lạc quan" (mất dòng ngay, gọi
  // máy tính sau), `isSessionBusy` để chấm trạng thái không chỉ nhìn "busy".
  dropSessionById,
  dropStatusById,
  isSessionBusy,
} from "../lib/session-ops.js";
import { sessionTitleOf } from "../lib/session-rename.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList, SwipeRow } from "../components/ui.jsx";
import { PlusIcon, SearchIcon } from "../components/icons.jsx";

export function SessionsPage({ route }) {
  const { wsId } = route;
  const [sessions, setSessions] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);

  // ---- Chống race: đổi workspace / rời màn lúc đang tải ----
  // lib/load-guard (một primitive chung với files/home/search — trước đây 4
  // trang tự chế 4 dạng không giông nhau): `gen` tăng mỗi lần wsId đổi và lúc
  // rời màn; token nào cũ hơn thì bỏ, không vẽ đè lên danh sách của workspace
  // MỚI (trước đây trả về trễ là danh sách sai workspace hiện lên ngay). Kind
  // riêng cho từng loại tải chặn hai lượt CÙNG loại chạy đè nhau (SSE đến đúng
  // lúc đang bấm "Thử lại").
  const guardRef = useRef(null);
  if (!guardRef.current) guardRef.current = createLoadGuard();

  // Bản sao mới nhất của hai state trên, để hoàn tác xoá kiểu lạc quan KHÔNG
  // ghi đè một lượt load() nào vừa về đúng lúc đó.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const deletingRef = useRef(new Set()); // id đang bay, chặn vuốt hai lần
  const creatingRef = useRef(false); // chặn bấm nút (+) hai lần

  async function load() {
    const token = guardRef.current.begin("sessions");
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session`, {
        signal: token.signal,
      });
      if (guardRef.current.stale(token)) return;
      const rows = unwrap(payload) ?? [];
      rows.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      setSessions(rows);
      setError("");
    } catch (e) {
      if (guardRef.current.stale(token) || e?.name === "AbortError") return;
      setError(errorSentence(e));
    }
  }

  async function loadStatuses() {
    const token = guardRef.current.begin("statuses");
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session/status`, {
        signal: token.signal,
      });
      if (guardRef.current.stale(token)) return;
      setStatuses(unwrap(payload) ?? payload ?? {});
    } catch {
      /* status là bonus - bỏ qua lỗi */
    }
  }

  useEffect(() => {
    guardRef.current.invalidate(); // token của wsId cũ thành stale (bấm nhanh qua 2 ws)
    load();
    loadStatuses();
    // Stream event engine (lib/sse.js — fetch, token bằng header): session
    // hoặc message đổi là refresh gộp sau 700ms, khỏi poll định kỳ.
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        load();
        loadStatuses();
      }, 700);
    };
    const stopEvents = connectEvents(
      `${OW_PROXY_PREFIX}/workspace/${encodeURIComponent(wsId)}/opencode/event`,
      () => schedule(),
    );
    return () => {
      clearTimeout(timer);
      guardRef.current.invalidate(); // vô hiệu mọi request đang bay (không vẽ sau khi rời màn)
      stopEvents();
    };
  }, [wsId]);

  async function newSession() {
    if (creatingRef.current) return; // bấm nút (+) hai lần -> chỉ tạo một phiên
    creatingRef.current = true;
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
      setError(errorSentence(e));
    } finally {
      creatingRef.current = false;
    }
  }

  /**
   * Xoá phiên bằng cử chỉ vuốt. Ba lỗi cũ đã sửa ở đây:
   *   1. Vuốt hai lần trong lúc request cũ còn bay -> hai lệnh DELETE, lần hai
   *      trả 404 và người dùng thấy banner lỗi oang oang dù phiên ĐÃ xoá.
   *   2. Xoá hỏng (máy tính ngủ, mất mạng) thì `load()` ngay sau đó gọi
   *      setError("") và XOÁ MẤT chính dòng báo lỗi — phiên quay lại y như cũ,
   *      không có một chữ nào giải thích.
   *   3. Cho tới khi `load()` về, dòng vẫn còn nguyên trên màn nên tay bấm
   *      tiếp cứ tưởng chưa xoá. Giờ mất dòng ngay, hỏng thì trả lại.
   */
  async function remove(s) {
    setOpenId(null);
    const id = String(s?.id ?? "");
    if (!id || deletingRef.current.has(id)) return;
    deletingRef.current.add(id);
    const beforeSessions = sessionsRef.current;
    const beforeStatuses = statusesRef.current;
    const afterDrop = dropSessionById(beforeSessions, id);
    const afterStatuses = dropStatusById(beforeStatuses, id);
    setSessions(afterDrop);
    setStatuses(afterStatuses);
    try {
      await owDeleteSession(wsId, id);
      setError("");
      load(); // nạp lại cho chắc: engine có thể đã đổi thêm sau lúc ta xoá
    } catch (e) {
      // Chỉ trả lại lúc này nếu chưa có lượt load() nào về đè giữa chừng —
      // nếu có thì danh sách mới đã đúng hơn, giữ nguyên nó.
      if (sessionsRef.current === afterDrop) setSessions(beforeSessions);
      if (statusesRef.current === afterStatuses) setStatuses(beforeStatuses);
      setError(`Failed to delete this session: ${errorSentence(e)}`);
    } finally {
      deletingRef.current.delete(id);
    }
  }

  const list = sessions ?? [];

  return (
    <>
      {error && <Banner kind="err" actionLabel="Retry" onAction={load}>{error}</Banner>}

      {sessions === null && !error && <SkeletonList rows={3} />}

      {sessions?.length === 0 && (
        <Empty
          icon
          title="No sessions yet"
          hint="Tap (+) to start chatting with the agent."
          actionLabel="New session"
          onAction={newSession}
        />
      )}

      {sessions?.length > 0 && (
        <>
          <div class="fs-chips scroll">
            <button
              type="button"
              class="btn small ghost"
              onClick={() => navigate(`#/ws/${encodeURIComponent(wsId)}/search`)}
            >
              <SearchIcon size={16} /> Search in workspace
            </button>
          </div>

          {list.map((s) => {
            const status = statuses[s.id]?.type;
            const running = isSessionBusy(statuses[s.id]);
            return (
              <SwipeRow
                key={s.id}
                open={openId === s.id}
                requestOpen={(v) => setOpenId(v ? s.id : null)}
                onAction={() => remove(s)}
                onTap={() => navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(s.id)}`)}
              >
                <div
                  class="card tap dense"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(s.id)}`);
                    }
                  }}
                >
                  <div class="row-between">
                    <h3>{sessionTitleOf(s)}</h3>
                    <div class="page-actions">
                      <span class={`dot ${running ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
                    </div>
                  </div>
                  <div class="row-between">
                    <span class="meta">{timeAgo(s.time?.updated)}</span>
                  </div>
                </div>
              </SwipeRow>
            );
          })}
        </>
      )}

      <button class="fab" aria-label="New session" onClick={newSession}>
        <PlusIcon size={24} />
      </button>
    </>
  );
}
