import { useEffect, useState } from "preact/hooks";
import { apiFsList, apiFsMkdir, ow, unwrap } from "../api.js";
import { navigate } from "../app.jsx";
import { FolderIcon, WsIcon } from "../components/icons.jsx";
import { Banner, Empty, Loading } from "../components/ui.jsx";
import { wsColor } from "./home.jsx";

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const payload = await ow("/workspaces");
      setWorkspaces(unwrap(payload)?.workspaces ?? payload?.workspaces ?? []);
      setError("");
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div class="page-head">
        <span class="hint">{workspaces ? `${workspaces.length} workspace` : "…"}</span>
      </div>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={load}>{error}</Banner>}

      {workspaces === null && !error && <Loading />}

      {workspaces?.length === 0 && (
        <Empty
          icon
          title="Chưa có workspace nào"
          hint="Thêm thư mục từ máy tính để bắt đầu làm việc với agent."
          actionLabel="Thêm workspace"
          onAction={() => setShowCreate(true)}
        />
      )}

      {workspaces?.map((ws) => (
        <div
          key={ws.id}
          class="card tap ws-card"
          style={`--ws-c:${wsColor(ws.id)}`}
          onClick={() => navigate(`#/ws/${encodeURIComponent(ws.id)}`)}
        >
          <div style="display:flex;gap:12px;align-items:flex-start">
            <span class="tile" aria-hidden="true"><WsIcon /></span>
            <div style="flex:1;min-width:0">
              <div class="row-between">
                <h3 style="margin:0;display:flex;align-items:center;gap:8px;min-width:0">
                  <span class="ws-dot" style={`background:${wsColor(ws.id)}`} aria-hidden="true" />
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{ws.name || ws.displayName || ws.id}</span>
                </h3>
                <span class="badge">{ws.workspaceType === "remote" ? "remote" : "local"}</span>
              </div>
              <div class="meta mono">{ws.path ?? ""}</div>
              <div class="page-actions" style="margin-top:10px">
                <button
                  class="btn small primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`#/ws/${encodeURIComponent(ws.id)}`);
                  }}
                >
                  Sessions
                </button>
                <button
                  class="btn small ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`#/ws/${encodeURIComponent(ws.id)}/files`);
                  }}
                >
                  Files
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      <button class="fab" aria-label="Thêm workspace" onClick={() => setShowCreate(true)}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {showCreate && <CreateWorkspaceDialog onClose={() => setShowCreate(false)} onCreated={load} />}
    </>
  );
}

function CreateWorkspaceDialog({ onClose, onCreated }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPicker, setShowPicker] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      // Server đòi tên trường `folderPath` (gửi `path` sẽ bị chửi "folderPath is required");
      // folder chưa tồn tại cũng được — server tự mkdir (ensureDir).
      await ow("/workspaces/local", { method: "POST", body: { folderPath: path.trim(), name: name.trim() || undefined } });
      onCreated();
      onClose();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="card sheet" role="dialog" aria-modal="true" aria-label="Tạo workspace mới" onClick={(e) => e.stopPropagation()}>
        <h3>Tạo workspace mới</h3>
        <label class="field" for="new-ws-path">Đường dẫn thư mục trên máy tính (vd: C:\Projects\MyApp)</label>
        <div style="display:flex;gap:8px">
          <input
            id="new-ws-path"
            type="text"
            style="flex:1;min-width:0"
            value={path}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setPath(e.currentTarget.value)}
            placeholder="C:\Projects\MyApp…"
          />
          <button class="btn" style="flex:none" onClick={() => setShowPicker(true)}>
            Duyệt…
          </button>
        </div>
        <label class="field" for="new-ws-name">Tên hiển thị (tùy chọn)</label>
        <input
          id="new-ws-name"
          type="text"
          value={name}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setName(e.currentTarget.value)}
          placeholder="MyApp…"
        />
        {error && <Banner kind="err">{error}</Banner>}
        <div class="sheet-actions">
          <button class="btn ghost" onClick={onClose}>
            Đóng
          </button>
          <button class="btn" disabled={busy || !path.trim()} onClick={create}>
            {busy ? "Đang tạo…" : "Tạo"}
          </button>
        </div>
      </div>
      {showPicker && <FolderPickerSheet onPick={(p) => { setPath(p); setShowPicker(false); }} onClose={() => setShowPicker(false)} />}
    </div>
  );
}

/** Sheet duyệt thư mục máy tính: chọc ổ đĩa → thư mục → bấm chọn.
 * Mở lần đầu rơi vào thư mục Nhà cho nhanh; có nút tạo thư mục mới cho project chưa có chỗ ở. */
function FolderPickerSheet({ onPick, onClose }) {
  const [quick, setQuick] = useState(null); // {roots, quick, home} từ bridge
  const [view, setView] = useState(null); // {kind:"dir", path, parent, dirs} hoặc {kind:"roots"}
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [creating, setCreating] = useState(false);

  async function goTo(target) {
    setLoading(true);
    setError("");
    try {
      const data = await apiFsList(target);
      setView({ kind: "dir", ...data });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function createDir() {
    if (!view?.path || !newDirName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const made = await apiFsMkdir(view.path, newDirName.trim());
      setNewDirOpen(false);
      setNewDirName("");
      await goTo(made.path); // tạo xong chọc thẳng vào thư mục mới
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setCreating(false);
    }
  }

  function goUp() {
    if (!view || view.kind !== "dir") return;
    if (view.parent) goTo(view.parent);
    else if (quick) setView({ kind: "roots" }); // đang ở gốc ổ đĩa → về danh sách ổ
  }

  useEffect(() => {
    (async () => {
      try {
        const roots = await apiFsList();
        setQuick(roots);
        // Có thư mục Nhà thì mở luôn đó, không thì vào ổ đầu tiên
        const start = roots.home ?? roots.roots?.[0]?.path;
        if (start) {
          const data = await apiFsList(start);
          setView({ kind: "dir", ...data });
        } else {
          setView({ kind: "roots" });
        }
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const canPick = view?.kind === "dir";

  return (
    <div
      class="sheet-backdrop"
      style="z-index:60"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div class="card sheet" role="dialog" aria-modal="true" aria-label="Chọn thư mục" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-grabber" aria-hidden="true" />
        <h3 style="margin-bottom:10px">Chọn thư mục</h3>

        {quick && (
          <div class="fs-chips">
            {quick.quick?.map((q) => (
              <button key={q.path} class="btn small ghost" disabled={loading} onClick={() => goTo(q.path)}>
                {q.label}
              </button>
            ))}
            {quick.roots?.map((r) => (
              <button key={r.path} class="btn small ghost" disabled={loading} onClick={() => goTo(r.path)}>
                Ổ {r.name}
              </button>
            ))}
          </div>
        )}

        {view?.kind === "dir" && (
          <div class="fs-path mono" title={view.path}>
            {view.path}
          </div>
        )}

        {view?.kind === "dir" && (
          <div style="margin-bottom:8px">
            {newDirOpen ? (
              <div style="display:flex;gap:8px">
                <input
                  type="text"
                  style="flex:1;min-width:0"
                  value={newDirName}
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="Tên thư mục mới…"
                  onInput={(e) => setNewDirName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createDir();
                  }}
                />
                <button class="btn" style="flex:none" disabled={creating || !newDirName.trim()} onClick={createDir}>
                  Tạo
                </button>
                <button class="btn ghost" style="flex:none" onClick={() => { setNewDirOpen(false); setNewDirName(""); }}>
                  Hủy
                </button>
              </div>
            ) : (
              <button class="btn small ghost" disabled={loading} onClick={() => setNewDirOpen(true)}>
                + Thư mục mới
              </button>
            )}
          </div>
        )}

        {view?.kind === "dir" && (
          <div class="fs-list">
            <button class="fs-row" disabled={loading} onClick={goUp}>
              <span class="fs-up" aria-hidden="true">↩</span>
              <span style="flex:1">{view.parent ? "Lên cấp trên" : "Danh sách ổ đĩa"}</span>
            </button>
            {view.dirs?.map((d) => (
              <button key={d.path} class="fs-row" disabled={loading} onClick={() => goTo(d.path)}>
                <FolderIcon size={18} />
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{d.name}</span>
              </button>
            ))}
            {!loading && view.dirs?.length === 0 && <div class="hint" style="padding:8px 2px">Không có thư mục con nào.</div>}
          </div>
        )}

        {view?.kind === "roots" && quick && (
          <div class="fs-list">
            {quick.roots?.map((r) => (
              <button key={r.path} class="fs-row" disabled={loading} onClick={() => goTo(r.path)}>
                <FolderIcon size={18} />
                <span style="flex:1">Ổ {r.name}</span>
              </button>
            ))}
          </div>
        )}

        {loading && <Loading />}
        {error && <Banner kind="err">{error}</Banner>}

        <div class="sheet-actions">
          <button class="btn ghost" onClick={onClose}>
            Đóng
          </button>
          <button class="btn primary" disabled={loading || !canPick} onClick={() => canPick && onPick(view.path)}>
            Chọn thư mục này
          </button>
        </div>
      </div>
    </div>
  );
}
