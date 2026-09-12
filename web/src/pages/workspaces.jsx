import { useEffect, useState } from "preact/hooks";
import { ow, unwrap } from "../api.js";
import { navigate } from "../app.jsx";
import { PlusIcon, WsIcon } from "../components/icons.jsx";
import { Banner, Empty, Loading } from "../components/ui.jsx";

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
        <div key={ws.id} class="card tap" onClick={() => navigate(`#/ws/${encodeURIComponent(ws.id)}`)}>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <span class="tile" aria-hidden="true"><WsIcon /></span>
            <div style="flex:1;min-width:0">
              <div class="row-between">
                <h3 style="margin:0">{ws.name || ws.displayName || ws.id}</h3>
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
        <PlusIcon size={24} />
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

  async function create() {
    setBusy(true);
    setError("");
    try {
      await ow("/workspaces/local", { method: "POST", body: { path: path.trim(), name: name.trim() || undefined } });
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
        <input
          id="new-ws-path"
          type="text"
          value={path}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => setPath(e.currentTarget.value)}
          placeholder="C:\Projects\MyApp…"
        />
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
    </div>
  );
}
