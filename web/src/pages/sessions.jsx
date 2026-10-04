import { useEffect, useRef, useState } from "preact/hooks";
import { ow, owDeleteSession, unwrap, timeAgo } from "../api.js";
import { connectEvents } from "../lib/sse.js";
import {
  // Xoá phiên + trạng thái đang chạy: luật thuần ở lib/session-ops.js để test
  // được. `dropSessionById` là phần "xoá kiểu lạc quan" (mất dòng ngay, gọi
  // máy tính sau), `isSessionBusy` để chấm trạng thái không chỉ nhìn "busy".
  dropSessionById,
  dropStatusById,
  isSessionBusy,
} from "../lib/session-ops.js";
import {
  // Sắp xếp phiên: ghim · lưu trữ (localStorage) · nhóm phiên (server).
  // Toàn bộ luật nằm ở lib/session-organize.js để test được, file này chỉ gọi.
  UNGROUPED_ID,
  UNGROUPED_LABEL,
  MAX_GROUP_LABEL_LENGTH,
  addGroup,
  buildAssignBody,
  buildReorderBody,
  emptyGroupState,
  groupCounts,
  groupIdOf,
  groupStateFromResponse,
  loadFlags,
  moveGroup,
  removeGroup,
  renameGroup,
  saveFlags,
  selectSessions,
  sessionGroupAssignmentPath,
  sessionGroupPath,
  sessionGroupReorderPath,
  sessionGroupsPath,
  setAssignment,
  removeGroupPath,
  sortByUpdated,
  toggleFlag,
  flagOn,
} from "../lib/session-organize.js";
import { sessionTitleOf } from "../lib/session-rename.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList, SwipeRow, useConfirm } from "../components/ui.jsx";
import { CheckIcon, ChevronDownIcon, FolderIcon, Icon, PlusIcon, SearchIcon } from "../components/icons.jsx";

// Icon ghim/lưu trữ khai ở đây chứ không thêm vào components/icons.jsx: đó là
// file dùng chung, vòng này không agent nào được sửa. Vẽ bằng đúng bộ `Icon`
// (stroke 2, currentColor) nên nhìn không lệch các icon còn lại. Khi tới vòng
// tích hợp, chuyển hai hàm này xuống components/icons.jsx và xoá export ở đây.
export function PinIcon({ size, filled = false }) {
  return (
    <Icon size={size ?? 18}>
      <path d="M12 17v5" />
      <path
        d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"
        fill={filled ? "currentColor" : "none"}
      />
    </Icon>
  );
}

export function ArchiveIcon({ size }) {
  return (
    <Icon size={size ?? 18}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Icon>
  );
}

function ChevronUpIcon({ size }) {
  return (
    <Icon size={size ?? 16}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

/** Ba ô lọc: tất cả (ẩn mục đã lưu trữ) · ghim · lưu trữ. */
const SCOPES = [
  { id: "all", label: "Tất cả" },
  { id: "pinned", label: "Ghim" },
  { id: "archived", label: "Lưu trữ" },
];

export function SessionsPage({ route }) {
  const { wsId } = route;
  const [sessions, setSessions] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);

  // ---- Sắp xếp phiên ----
  const [flags, setFlags] = useState(() => loadFlags(wsId));
  const [groupState, setGroupState] = useState(emptyGroupState);
  const [scope, setScope] = useState("all");
  const [groupId, setGroupId] = useState(null); // null = mọi nhóm
  const [sheet, setSheet] = useState(null); // {mode:"assign", session} | {mode:"manage"}
  const [busy, setBusy] = useState(false); // đang gửi PATCH/POST/DELETE
  const [confirmDialog, askConfirm] = useConfirm();

  // ---- Chống race: đổi workspace / rời màn lúc đang tải ----
  // `gen` tăng mỗi lần wsId đổi và lúc rời màn; request nào cũ hơn gen hiện tại
  // thì bỏ, không vẽ đè lên danh sách của workspace MỚI (trước đây trả về
  // trễ là danh sách sai workspace hiện lên ngay). `seq` chặn hai lượt tải
  // CÙNG loại chạy đè nhau (SSE đến đúng lúc đang bấm "Thử lại"). Đúng cách
  // pages/files.jsx:41-64 làm (AbortController + seq).
  const genRef = useRef(0);
  const seqRef = useRef({ sessions: 0, statuses: 0, groups: 0 });
  const abortRef = useRef({});

  function begin(kind) {
    const seq = (seqRef.current[kind] ?? 0) + 1;
    seqRef.current[kind] = seq;
    abortRef.current[kind]?.abort();
    const ctrl = new AbortController();
    abortRef.current[kind] = ctrl;
    return { kind, seq, gen: genRef.current, ctrl };
  }

  function isStale(token) {
    return token.gen !== genRef.current || seqRef.current[token.kind] !== token.seq;
  }

  // Bản sao mới nhất của hai state trên, để hoàn tác xoá kiểu lạc quan KHÔNG
  // ghi đè một lượt load() nào vừa về đúng lúc đó.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  const deletingRef = useRef(new Set()); // id đang bay, chặn vuốt hai lần
  const creatingRef = useRef(false); // chặn bấm nút (+) hai lần
  const busyCountRef = useRef(0); // đếm request, không phải cờ boolean

  async function load() {
    const token = begin("sessions");
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session`, {
        signal: token.ctrl.signal,
      });
      if (isStale(token)) return;
      setSessions(sortByUpdated(unwrap(payload) ?? []));
      setError("");
    } catch (e) {
      if (isStale(token) || e?.name === "AbortError") return;
      setError(String(e.message || e));
    }
  }

  async function loadStatuses() {
    const token = begin("statuses");
    try {
      const payload = await ow(`/workspace/${encodeURIComponent(wsId)}/opencode/session/status`, {
        signal: token.ctrl.signal,
      });
      if (isStale(token)) return;
      setStatuses(unwrap(payload) ?? payload ?? {});
    } catch {
      /* status là bonus - bỏ qua lỗi */
    }
  }

  /** Nhóm phiên nằm trên máy tính — GET /session-groups (đã whitelist proxy). */
  async function loadGroups() {
    const token = begin("groups");
    try {
      const next = groupStateFromResponse(
        await ow(sessionGroupsPath(wsId), { signal: token.ctrl.signal }),
      );
      if (isStale(token)) return;
      setGroupState(next);
    } catch {
      /* không có nhóm cũng dùng được app — bỏ qua, đừng chặn danh sách phiên */
    }
  }

  useEffect(() => {
    genRef.current += 1;
    load();
    loadStatuses();
    loadGroups();
    setFlags(loadFlags(wsId)); // đổi workspace thì cờ cũng phải đổi theo
    setScope("all");
    setGroupId(null);
    setSheet(null); // sheet đang mở thuộc workspace CŨ, đóng luôn
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
      `/api/ow/workspace/${encodeURIComponent(wsId)}/opencode/event`,
      () => schedule(),
    );
    return () => {
      clearTimeout(timer);
      genRef.current += 1; // vô hiệu mọi request đang bay (không vẽ sau khi rời màn)
      for (const ctrl of Object.values(abortRef.current)) ctrl?.abort();
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
      setError(String(e.message || e));
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
      setError(`Không xoá được phiên này: ${e?.message || e}`);
    } finally {
      deletingRef.current.delete(id);
    }
  }

  // ---- Ghim / lưu trữ: chỉ ở máy đang cầm, không gọi server ----
  function flipFlag(kind, s) {
    const next = saveFlags(wsId, toggleFlag(flags, kind, s.id));
    setFlags(next);
  }

  // ---- Nhóm phiên: server là nguồn chân lý, nhưng cập nhật trước rồi hoàn tác
  // ---- nếu PATCH lỗi, để bấm không phải chờ mạng ----
  async function send(fn, optimistic) {
    busyCountRef.current += 1;
    setBusy(true);
    const previous = groupState;
    if (optimistic) setGroupState(optimistic);
    try {
      await fn();
      setError("");
    } catch (e) {
      setGroupState(previous);
      setError(`Không lưu được nhóm phiên. ${String(e.message || e)}`);
    } finally {
      // Đếm chứ không bật/tắt cờ: hai thao tác chồng nhau (bấm nhanh hai nút
      // Lên/Xuống) thì lệnh thứ nhất về sớm không được tắt busy của lệnh sau.
      busyCountRef.current = Math.max(0, busyCountRef.current - 1);
      setBusy(busyCountRef.current > 0);
    }
  }

  function moveSession(session, gid) {
    send(
      () =>
        ow(sessionGroupAssignmentPath(wsId, session.id), {
          method: "PATCH",
          body: buildAssignBody(gid),
        }),
      setAssignment(groupState, session.id, gid),
    );
  }

  function createGroup(rawLabel) {
    const prepared = addGroup(groupState, rawLabel);
    if (!prepared.ok) {
      setError(prepared.error);
      return false;
    }
    send(
      // id do mình sinh (slug) nên state client khớp ngay, không phải chờ GET lại
      () =>
        ow(sessionGroupsPath(wsId), {
          method: "POST",
          body: { label: prepared.label, id: prepared.id },
        }),
      prepared.state,
    );
    return true;
  }

  function doRename(gid, rawLabel) {
    const prepared = renameGroup(groupState, gid, rawLabel);
    if (!prepared.ok) {
      setError(prepared.error);
      return false;
    }
    const label = prepared.state.groups.find((g) => g.id === gid)?.label ?? "";
    send(() => ow(sessionGroupPath(wsId, gid), { method: "PATCH", body: { label } }), prepared.state);
    return true;
  }

  function doReorder(gid, delta) {
    const next = moveGroup(groupState, gid, delta);
    const ids = next.groups.map((g) => g.id);
    send(() => ow(sessionGroupReorderPath(wsId), { method: "PATCH", body: buildReorderBody(ids) }), next);
  }

  function doRemoveGroup(g) {
    askConfirm({
      title: `Xoá nhóm “${g.label}”?`,
      body: "Các phiên trong nhóm sẽ chuyển sang “Chưa nhóm”, không phiên nào bị xoá.",
      confirmLabel: "Xoá nhóm",
      onConfirm: () => {
        // Nhóm đang lọc mà bị xoá thì bỏ luôn bộ lọc, không để màn trống vô lý
        if (groupId === g.id) setGroupId(null);
        send(() => ow(removeGroupPath(wsId, g.id), { method: "DELETE" }), removeGroup(groupState, g.id));
      },
    });
  }

  const list = selectSessions(sessions ?? [], { flags, scope, groupId, groupState });
  // Số trên chip nhóm phải khớp danh sách ĐANG hiện: cùng bộ lọc scope, chỉ
  // khác ở chỗ chưa cắt theo nhóm. Trước đây đếm trên MỌI phiên nên ở mục
  // "Tất cả" chip vẫn tính cả phiên đã lưu trữ (đang bị ẩn) — người dùng
  // thấy "Nhóm A (5)" mà list chỉ ra 3 dòng rồi tưởng mất phiên.
  const visible = selectSessions(sessions ?? [], { flags, scope, groupState });
  const counts = groupCounts(visible, groupState);
  const archivedCount = selectSessions(sessions ?? [], { flags, scope: "archived" }).length;
  const looseCount = visible.filter((s) => !groupIdOf(groupState, s.id)).length;

  return (
    <>
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

      {sessions?.length > 0 && (
        <>
          {/* Một hàng chip làm hết: lọc cờ + lọc nhóm + mở quản lý nhóm.
              Chip là <span> trạng thái, nhưng ở đây bấm đổi bộ lọc nên là nút. */}
          <div class="fs-chips" role="group" aria-label="Lọc danh sách phiên">
            {SCOPES.map((sc) => (
              <button
                key={sc.id}
                type="button"
                class="btn small ghost"
                aria-pressed={scope === sc.id}
                style={scope === sc.id ? "font-weight:700" : undefined}
                onClick={() => setScope(sc.id)}
              >
                {sc.label}
                {sc.id === "archived" && archivedCount ? ` (${archivedCount})` : ""}
              </button>
            ))}
            {groupState.groups.map((g) => (
              <button
                key={g.id}
                type="button"
                class="btn small ghost"
                aria-pressed={groupId === g.id}
                onClick={() => setGroupId(groupId === g.id ? null : g.id)}
              >
                {g.label} ({counts[g.id] ?? 0})
              </button>
            ))}
            {/* Ô "Chưa nhóm" chỉ hiện khi còn phiên chưa xếp — để dọn nốt thì
                mới thấy; lúc nào cũng hiện thì lấp át cả nhóm thật. */}
            {looseCount > 0 && (
              <button
                type="button"
                class="btn small ghost"
                aria-pressed={groupId === UNGROUPED_ID}
                onClick={() => setGroupId(groupId === UNGROUPED_ID ? null : UNGROUPED_ID)}
              >
                {UNGROUPED_LABEL} ({looseCount})
              </button>
            )}
            <button type="button" class="btn small ghost" onClick={() => setSheet({ mode: "manage" })}>
              <FolderIcon size={16} /> Nhóm phiên
            </button>
            <button
              type="button"
              class="btn small ghost"
              onClick={() => navigate(`#/ws/${encodeURIComponent(wsId)}/search`)}
            >
              <SearchIcon size={16} /> Tìm trong workspace
            </button>
          </div>

          {list.length === 0 && (
            <Empty
              icon={scope === "archived" ? ArchiveIcon : scope === "pinned" ? PinIcon : undefined}
              title={
                scope === "archived"
                  ? "Chưa lưu trữ phiên nào"
                  : scope === "pinned"
                    ? "Chưa ghim phiên nào"
                    : groupId
                      ? "Nhóm này chưa có phiên"
                      : "Không còn phiên nào ở mục này"
              }
              hint={
                scope === "all" && groupId
                  ? "Nhóm vẫn còn trên máy tính — thêm phiên vào nhóm bằng nút nhóm trên từng phiên."
                  : "Ghim để lên đầu danh sách, lưu trữ để dọn chỗ. Cả hai chỉ lưu trên máy này."
              }
            />
          )}

          {list.map((s) => {
            const status = statuses[s.id]?.type;
            const running = isSessionBusy(statuses[s.id]);
            const pinned = flagOn(flags, "pinned", s.id);
            const gid = groupIdOf(groupState, s.id);
            const gLabel = gid ? groupState.groups.find((g) => g.id === gid)?.label : "";
            return (
              <SwipeRow
                key={s.id}
                open={openId === s.id}
                requestOpen={(v) => setOpenId(v ? s.id : null)}
                onAction={() => remove(s)}
                onTap={() => navigate(`#/ws/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(s.id)}`)}
              >
                <div
                  class="card tap"
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
                      <button
                        type="button"
                        class="btn small ghost btn-icon"
                        aria-pressed={pinned}
                        aria-label={pinned ? "Bỏ ghim phiên này" : "Ghim phiên lên đầu danh sách"}
                        onClick={(e) => {
                          e.stopPropagation(); // nếu không, SwipeRow coi là tap -> mở phiên
                          flipFlag("pinned", s);
                        }}
                      >
                        <PinIcon size={16} filled={pinned} />
                      </button>
                      <span class={`dot ${running ? "busy" : "ok"}`} aria-label={status ?? "idle"} />
                    </div>
                  </div>
                  <div class="row-between" style="margin-top:6px">
                    <span class="meta">
                      {gLabel ? `${gLabel} · ` : ""}
                      {timeAgo(s.time?.updated)}
                    </span>
                    <div class="page-actions">
                      <button
                        type="button"
                        class="btn small ghost btn-icon"
                        aria-label={`Xếp phiên này vào nhóm (đang ở: ${gLabel || UNGROUPED_LABEL})`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSheet({ mode: "assign", session: s });
                        }}
                      >
                        <FolderIcon size={16} />
                      </button>
                      <button
                        type="button"
                        class="btn small ghost btn-icon"
                        aria-label="Lưu trữ phiên này"
                        onClick={(e) => {
                          e.stopPropagation();
                          flipFlag("archived", s);
                        }}
                      >
                        <ArchiveIcon size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </SwipeRow>
            );
          })}
        </>
      )}

      {sheet?.mode === "assign" && (
        <AssignSheet
          session={sheet.session}
          groupState={groupState}
          busy={busy}
          onPick={(gid) => {
            moveSession(sheet.session, gid);
            setSheet(null);
          }}
          onCreate={(label) => createGroup(label)}
          onManage={() => setSheet({ mode: "manage" })}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet?.mode === "manage" && (
        <ManageGroupsSheet
          groupState={groupState}
          busy={busy}
          onCreate={createGroup}
          onRename={doRename}
          onMove={doReorder}
          onRemove={doRemoveGroup}
          onClose={() => setSheet(null)}
        />
      )}

      {confirmDialog}

      <button class="fab" aria-label="Tạo session mới" onClick={newSession}>
        <PlusIcon size={24} />
      </button>
    </>
  );
}

/** Sheet xếp một phiên vào nhóm. Ô nhập 16px (chống iOS zoom), item ≥44px. */
function AssignSheet({ session, groupState, busy, onPick, onCreate, onManage, onClose }) {
  const [label, setLabel] = useState("");
  const current = groupIdOf(groupState, session.id);

  function submit(e) {
    e.preventDefault();
    if (onCreate(label)) setLabel("");
  }

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet model-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Chọn nhóm cho phiên"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <div class="sheet-body">“{sessionTitleOf(session)}” — chọn nhóm để xếp phiên này vào.</div>
        <div class="model-list" style="flex:1;min-height:0">
          <button type="button" class="model-option" onClick={() => onPick("")}>
            <span class="model-option-text">
              <span class="model-option-name">{UNGROUPED_LABEL}</span>
            </span>
            {!current && <CheckIcon size={18} />}
          </button>
          {groupState.groups.map((g) => (
            <button key={g.id} type="button" class="model-option" onClick={() => onPick(g.id)}>
              <span class="model-option-text">
                <span class="model-option-name">{g.label || g.id}</span>
              </span>
              {current === g.id && <CheckIcon size={18} />}
            </button>
          ))}
        </div>
        <form class="sheet-actions" onSubmit={submit} style="align-items:center">
          <input
            type="text"
            value={label}
            maxLength={MAX_GROUP_LABEL_LENGTH}
            placeholder="Tên nhóm mới"
            aria-label="Tên nhóm mới"
            disabled={busy}
            style="flex:1;min-width:0"
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
          <button type="submit" class="btn small primary" disabled={busy || !label.trim()}>
            Tạo
          </button>
        </form>
        <div class="sheet-actions">
          <button type="button" class="btn ghost" onClick={onManage}>
            Quản lý nhóm
          </button>
          <button type="button" class="btn ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

/** Sheet quản lý nhóm: tạo · đổi tên · đổi thứ tự · xoá (không xoá phiên). */
function ManageGroupsSheet({ groupState, busy, onCreate, onRename, onMove, onRemove, onClose }) {
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");

  function submitNew(e) {
    e.preventDefault();
    if (onCreate(label)) setLabel("");
  }

  function submitRename(gid) {
    if (onRename(gid, draft)) setEditing("");
  }

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="card sheet model-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Quản lý nhóm phiên"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="sheet-grabber" />
        <div class="sheet-body">
          Nhóm lưu trên máy tính, nên điện thoại này và máy khác thấy giống nhau.
        </div>

        <form class="sheet-actions" onSubmit={submitNew} style="align-items:center">
          <input
            type="text"
            value={label}
            maxLength={MAX_GROUP_LABEL_LENGTH}
            placeholder="Tên nhóm mới"
            aria-label="Tên nhóm mới"
            disabled={busy}
            style="flex:1;min-width:0"
            onInput={(e) => setLabel(e.currentTarget.value)}
          />
          <button type="submit" class="btn small primary" disabled={busy || !label.trim()}>
            Tạo
          </button>
        </form>

        {/* Mỗi nhóm là HAI dòng: tên ở trên, dải nút ở dưới — bốn nút 44px đứng
            cạnh nhau tràn ngang ở 360px. Dải nút có wrap nên không vỡ bố cục. */}
        <div class="model-list" style="flex:1;min-height:0">
          {groupState.groups.length === 0 && <p class="model-empty">Chưa có nhóm nào. Tạo một cái ở ô trên.</p>}
          {groupState.groups.map((g, i) => (
            <div key={g.id} style="padding:10px 6px;border-bottom:1px solid var(--border)">
              {editing === g.id ? (
                <div class="page-actions" style="align-items:center">
                  <input
                    type="text"
                    value={draft}
                    maxLength={MAX_GROUP_LABEL_LENGTH}
                    aria-label={`Đổi tên nhóm ${g.label}`}
                    style="flex:1;min-width:0"
                    onInput={(e) => setDraft(e.currentTarget.value)}
                  />
                  <button type="button" class="btn small primary" onClick={() => submitRename(g.id)}>
                    Lưu
                  </button>
                  <button type="button" class="btn small ghost" onClick={() => setEditing("")}>
                    Huỷ
                  </button>
                </div>
              ) : (
                <>
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      {g.label || g.id}
                    </span>
                  </div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
                    <button
                      type="button"
                      class="btn small ghost"
                      aria-label={`Đưa nhóm ${g.label} lên trên`}
                      disabled={busy || i === 0}
                      onClick={() => onMove(g.id, -1)}
                    >
                      <ChevronUpIcon size={14} /> Lên
                    </button>
                    <button
                      type="button"
                      class="btn small ghost"
                      aria-label={`Đưa nhóm ${g.label} xuống dưới`}
                      disabled={busy || i === groupState.groups.length - 1}
                      onClick={() => onMove(g.id, 1)}
                    >
                      <ChevronDownIcon size={14} /> Xuống
                    </button>
                    <button
                      type="button"
                      class="btn small ghost"
                      onClick={() => {
                        setEditing(g.id);
                        setDraft(g.label);
                      }}
                    >
                      Đổi tên
                    </button>
                    <button type="button" class="btn small danger" onClick={() => onRemove(g)}>
                      Xoá
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div class="sheet-actions">
          <button type="button" class="btn ghost" onClick={onClose}>
            Xong
          </button>
        </div>
      </div>
    </div>
  );
}
