import { useEffect, useState } from "preact/hooks";
import { ow, unwrap, timeAgo } from "../api.js";
import { navigate } from "../app.jsx";

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
      <div class="row-between" style="margin-bottom:12px">
        <span style="color:var(--text-dim);font-size:13px">{workspaces ? `${workspaces.length} workspace` : "…"}</span>
        <button class="btn small ghost" onClick={() => setShowCreate(true)}>
          + Thêm workspace
        </button>
      </div>

      {error && <div class="banner err"><span>{error}</span></div>}

      {workspaces === null && !error && <div class="empty"><span class="spinner" /> Đang tải…</div>}

      {workspaces?.length === 0 && <div class="empty">Chưa có workspace nào. Tạo mới bên OpenWork desktop hoặc bấm “Thêm workspace”.</div>}

      {workspaces?.map((ws) => (
        <div key={ws.id} class="card tap" onClick={() => navigate(`#/ws/${encodeURIComponent(ws.id)}`)}>
          <div class="row-between">
            <h3>{ws.name || ws.displayName || ws.id}</h3>
            <span class="badge">{ws.workspaceType === "remote" ? "remote" : "local"}</span>
          </div>
          <div class="meta mono">{ws.path ?? ""}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button
              class="btn small"
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
      ))}

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
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:flex-end" onClick={onClose}>
      <div
        class="card"
        style="margin:0;width:100%;border-radius:16px 16px 0 0;padding-bottom:calc(18px + var(--safe-bottom))"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Tạo workspace mới</h3>
        <label class="field">Đường dẫn thư mục trên máy tính (vd: C:\Projects\MyApp)</label>
        <input type="text" value={path} onInput={(e) => setPath(e.currentTarget.value)} placeholder="C:\Projects\MyApp" />
        <label class="field">Tên hiển thị (tùy chọn)</label>
        <input type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="MyApp" />
        {error && <p style="color:var(--danger);font-size:13px">{error}</p>}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
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
