import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, unwrap, sseUrl } from "../api.js";
import { navigate } from "../app.jsx";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonc", "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "html", "htm",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "gitignore", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "cmd", "sql", "csv", "tsv", "log", "svg",
  "lock", "editorconfig", "prettierrc", "eslintrc", "gitattributes", "dockerfile", "properties", "gradle",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

function extOf(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
  return name.slice(dot + 1).toLowerCase();
}

function isText(name) {
  return TEXT_EXT.has(extOf(name));
}
function isImage(name) {
  return IMAGE_EXT.has(extOf(name));
}

export function FilesPage({ route }) {
  const { wsId } = route;
  const [path, setPath] = useState(route.path ?? "");
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(null); // {name, path, kind: 'text'|'image'}
  const uploadRef = useRef(null);
  const wsEnc = encodeURIComponent(wsId);

  const load = useCallback(
    async (dir) => {
      try {
        const payload = await ow(`/workspace/${wsEnc}/opencode/file?path=${encodeURIComponent(dir)}`);
        const nodes = unwrap(payload) ?? [];
        const dirs = nodes.filter((n) => n.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
        const files = nodes.filter((n) => n.type !== "directory").sort((a, b) => a.name.localeCompare(b.name));
        setEntries([...dirs, ...files]);
        setError("");
      } catch (e) {
        setError(String(e.message || e));
        setEntries([]);
      }
    },
    [wsEnc]
  );

  useEffect(() => {
    load(path);
  }, [path]);

  useEffect(() => {
    // giữ path trong hash để back/forward hoạt động
    const target = `#/ws/${wsEnc}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`;
    if (location.hash !== target) history.replaceState(null, "", target);
  }, [path]);

  function openFile(node) {
    if (isImage(node.name)) setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "image" });
    else if (isText(node.name)) setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "text" });
    else setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "binary" });
  }

  async function uploadPicked(fileList) {
    for (const file of fileList) {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const target = path ? `${path.replace(/\/+$/, "")}/${file.name}` : file.name;
      try {
        await ow(`/workspace/${wsEnc}/files/raw`, {
          method: "POST",
          body: { path: target, dataBase64: base64 },
        });
      } catch (e) {
        setError(`Upload ${file.name} lỗi: ${e.message}`);
      }
    }
    load(path);
  }

  if (opened) {
    return (
      <FileViewer
        wsEnc={wsEnc}
        file={opened}
        onClose={() => {
          setOpened(null);
          load(path);
        }}
      />
    );
  }

  const crumbs = path ? path.split(/[\\/]+/).filter(Boolean) : [];

  return (
    <>
      <div class="row-between" style="margin-bottom:8px">
        <button class="btn small ghost" onClick={() => navigate(`#/ws/${wsEnc}`)}>
          ‹ Sessions
        </button>
        <div style="display:flex;gap:8px">
          <button class="btn small ghost" onClick={() => uploadRef.current?.click()}>
            ⬆ Upload
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              uploadPicked([...e.currentTarget.files]);
              e.currentTarget.value = "";
            }}
          />
          <button class="btn small ghost" onClick={() => load(path)}>
            ⟳
          </button>
        </div>
      </div>

      <div class="crumbs">
        <a href="#" onClick={(e) => { e.preventDefault(); setPath(""); }}>root</a>
        {crumbs.map((part, i) => (
          <>
            {" / "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setPath(crumbs.slice(0, i + 1).join("/"));
              }}
            >
              {part}
            </a>
          </>
        ))}
      </div>

      {error && <div class="banner err"><span>{error}</span></div>}
      {entries === null && <div class="empty"><span class="spinner" /> Đang tải…</div>}

      {path && (
        <div class="file-row" onClick={() => setPath(crumbs.slice(0, -1).join("/"))}>
          <span class="icon">📁</span>
          <span class="name" style="color:var(--text-dim)">..</span>
        </div>
      )}

      {entries?.map((node) => (
        <div class="file-row" key={node.path ?? node.name} onClick={() => (node.type === "directory" ? setPath(node.path) : openFile(node))}>
          <span class="icon">{node.type === "directory" ? "📁" : isImage(node.name) ? "🖼" : "📄"}</span>
          <span class="name">{node.name}</span>
          {node.type !== "directory" && node.size != null && (
            <span style="color:var(--text-dim);font-size:11.5px">{Math.max(1, Math.round(node.size / 1024))} KB</span>
          )}
        </div>
      ))}

      {entries?.length === 0 && !error && <div class="empty">Thư mục trống.</div>}
    </>
  );
}

function FileViewer({ wsEnc, file, onClose }) {
  const [content, setContent] = useState(null);
  const [edited, setEdited] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (file.kind !== "text") return;
    (async () => {
      try {
        const res = await ow(`/workspace/${wsEnc}/files/raw?path=${encodeURIComponent(file.path)}`, { raw: true });
        const text = await res.text();
        setContent(text);
        setEdited(text);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [file.path]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const base64 = btoa(unescape(encodeURIComponent(edited)));
      await ow(`/workspace/${wsEnc}/files/raw`, {
        method: "POST",
        body: { path: file.path, dataBase64: base64 },
      });
      setDirty(false);
    } catch (e) {
      setError(`Lưu lỗi: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const downloadUrl = sseUrl(`/workspace/${wsEnc}/files/raw?path=${encodeURIComponent(file.path)}`);

  return (
    <>
      <div class="row-between" style="margin-bottom:10px">
        <button class="btn small ghost" onClick={onClose}>
          ‹ Đóng
        </button>
        <div style="display:flex;gap:8px">
          <a class="btn small ghost" style="text-decoration:none" href={downloadUrl} download={file.name}>
            ⬇ Tải
          </a>
          {file.kind === "text" && (
            <button class="btn small" disabled={!dirty || saving} onClick={save}>
              {saving ? "Đang lưu…" : dirty ? "Lưu" : "Đã lưu"}
            </button>
          )}
        </div>
      </div>

      <div class="crumbs mono">{file.path}</div>
      {error && <div class="banner err"><span>{error}</span></div>}

      {file.kind === "text" && (
        <div class="file-editor">
          <textarea
            value={edited}
            onInput={(e) => {
              setEdited(e.currentTarget.value);
              setDirty(e.currentTarget.value !== content);
            }}
            spellcheck={false}
          />
        </div>
      )}

      {file.kind === "image" && (
        <div style="text-align:center">
          <img src={downloadUrl} alt={file.name} style="max-width:100%;border-radius:12px;border:1px solid var(--border)" />
        </div>
      )}

      {file.kind === "binary" && (
        <div class="empty">
          File nhị phân — bấm “Tải” để tải về điện thoại.
          <br />
          <span class="mono" style="font-size:11px">{file.name}</span>
        </div>
      )}
    </>
  );
}
