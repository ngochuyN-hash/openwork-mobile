import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, unwrap, sseUrl, owDownload, owUploadFile, formatBytes, bytesToBase64 } from "../api.js";
import { DownloadIcon, FileIcon, FolderIcon, ImageIcon, RefreshIcon, UploadIcon } from "../components/icons.jsx";
import { Banner, Empty, Loading } from "../components/ui.jsx";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonc", "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "html", "htm",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "gitignore", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "cmd", "sql", "csv", "tsv", "log",
  "lock", "editorconfig", "prettierrc", "eslintrc", "gitattributes", "dockerfile", "properties", "gradle",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const PDF_EXT = new Set(["pdf"]);

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
function isPdf(name) {
  return PDF_EXT.has(extOf(name));
}

export function FilesPage({ route }) {
  const { wsId } = route;
  const [path, setPath] = useState(route.path ?? "");
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState("");
  const [opened, setOpened] = useState(null); // {name, path, kind: 'text'|'image'|'pdf'|'binary'}
  const uploadRef = useRef(null);
  const wsEnc = encodeURIComponent(wsId);
  // Chống race khi bấm nhanh 2 thư mục: hủy fetch cũ (AbortController) + đếm
  // lượt (seq) — kết quả về trễ của thư mục CŨ không được vẽ dưới breadcrumb MỚI.
  const loadSeq = useRef(0);
  const loadAbort = useRef(null);

  const load = useCallback(
    async (dir) => {
      const seq = ++loadSeq.current;
      loadAbort.current?.abort();
      const controller = new AbortController();
      loadAbort.current = controller;
      try {
        const payload = await ow(`/workspace/${wsEnc}/opencode/file?path=${encodeURIComponent(dir)}`, {
          signal: controller.signal,
        });
        if (seq !== loadSeq.current) return; // đã có lượt load mới hơn — bỏ kết quả stale
        const nodes = unwrap(payload) ?? [];
        const dirs = nodes.filter((n) => n.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
        const files = nodes.filter((n) => n.type !== "directory").sort((a, b) => a.name.localeCompare(b.name));
        setEntries([...dirs, ...files]);
        setError("");
      } catch (e) {
        if (controller.signal.aborted || e?.name === "AbortError") return;
        if (seq !== loadSeq.current) return;
        setError(String(e.message || e));
        setEntries([]);
      }
    },
    [wsEnc]
  );

  // Rời trang thì hủy fetch đang treo (nếu có).
  useEffect(() => () => loadAbort.current?.abort(), []);

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
    else if (isPdf(node.name)) setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "pdf" });
    else if (isText(node.name)) setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "text" });
    else setOpened({ name: node.name, path: node.path ?? node.absolutePath, kind: "binary" });
  }

  async function uploadPicked(fileList) {
    setUploading(true);
    setUploadNote("");
    let done = 0;
    for (const file of fileList) {
      setUploadNote(`Đang tải lên ${done + 1}/${fileList.length}: ${file.name}…`);
      try {
        await owUploadFile(wsId, path, file);
        done += 1;
      } catch (e) {
        setError(`Upload ${file.name} lỗi: ${e.message}`);
      }
    }
    setUploading(false);
    setUploadNote(done ? `Đã tải lên ${done}/${fileList.length} file.` : "");
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
      <div class="page-head">
        <div class="page-actions" style="margin-left:auto">
          <button class="btn small ghost btn-icon" disabled={uploading} onClick={() => uploadRef.current?.click()}>
            <UploadIcon size={16} /> {uploading ? "Đang tải lên…" : "Tải lên"}
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabindex="-1"
            onChange={(e) => {
              uploadPicked([...e.currentTarget.files]);
              e.currentTarget.value = "";
            }}
          />
          <button class="btn small ghost btn-icon" aria-label="Tải lại danh sách file" onClick={() => load(path)}>
            <RefreshIcon size={16} />
          </button>
        </div>
      </div>

      <nav class="crumbs" aria-label="Đường dẫn thư mục">
        <a href="#" onClick={(e) => { e.preventDefault(); setPath(""); }}>root</a>
        {crumbs.map((part, i) => (
          <span key={i}>
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
          </span>
        ))}
      </nav>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={() => load(path)}>{error}</Banner>}
      {uploadNote && !error && <Banner kind="warn" actionLabel="Đã rõ" onAction={() => setUploadNote("")}>{uploadNote}</Banner>}
      {entries === null && <Loading />}

      {path && (
        <div
          class="file-row"
          role="button"
          tabIndex={0}
          onClick={() => setPath(crumbs.slice(0, -1).join("/"))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPath(crumbs.slice(0, -1).join("/"));
            }
          }}
        >
          <span class="icon"><FolderIcon /></span>
          <span class="name" style="color:var(--text-dim)">..</span>
        </div>
      )}

      {entries?.map((node) => (
        <div
          class="file-row"
          key={node.path ?? node.name}
          role="button"
          tabIndex={0}
          onClick={() => (node.type === "directory" ? setPath(node.path) : openFile(node))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              node.type === "directory" ? setPath(node.path) : openFile(node);
            }
          }}
        >
          <span class="icon">
            {node.type === "directory" ? <FolderIcon /> : isImage(node.name) ? <ImageIcon /> : <FileIcon />}
          </span>
          <span class="name">{node.name}</span>
          {node.type !== "directory" && node.size != null && (
            <span class="size">{formatBytes(node.size)}</span>
          )}
        </div>
      ))}

      {entries?.length === 0 && !error && (
        <Empty title="Thư mục trống" hint="Tải file lên để bắt đầu." actionLabel="Tải file lên" onAction={() => uploadRef.current?.click()} />
      )}
    </>
  );
}

function FileViewer({ wsEnc, file, onClose }) {
  const [content, setContent] = useState(null);
  const [edited, setEdited] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dl, setDl] = useState(null); // {loaded, total} khi đang tải | {done, filename, url, blob} khi xong
  const [dlError, setDlError] = useState("");
  const abortRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Mirror của dl cho cleanup: effect unmount đóng qua state sẽ STALE (giá trị
  // render đầu) — revokeObjectURL của lần tải xong không bao giờ chạy, mở vài
  // file lớn là iOS Safari giết tab. Đọc qua ref thì luôn là giá trị mới nhất.
  const dlRef = useRef(null);
  dlRef.current = dl;

  // Nút Đóng mượn topbar (ghim cố định): báo lên App qua event nội bộ, gửi 1 lần lúc mở.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("owm:topback", { detail: { label: "Đóng", onBack: () => closeRef.current() } }));
    return () => window.dispatchEvent(new CustomEvent("owm:topback", { detail: null }));
  }, []);

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
      const base64 = bytesToBase64(new TextEncoder().encode(edited));
      await ow(`/workspace/${wsEnc}/files/raw`, {
        method: "POST",
        body: { path: file.path, dataBase64: base64 },
      });
      setContent(edited);
      setDirty(false);
    } catch (e) {
      setError(`Lưu lỗi: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const downloadUrl = sseUrl(`/workspace/${wsEnc}/files/raw?path=${encodeURIComponent(file.path)}`);

  // Tải qua fetch + Blob: <a download> gốc hay bị Safari/PWA bỏ qua (mở file
  // trong tab thay vì lưu). Bản này hiện % + hủy được, xong mới kích <a download>.
  async function downloadFile() {
    if (abortRef.current) return;
    // Mở URL blob mới trước khi mở: thu hồi URL lần tải trước ngay tại đây
    // (setDl({loaded:0,...}) bên dưới sẽ đè trạng thái done cũ — không revoke
    // ở đây thì URL cũ leak cho tới khi unmount).
    if (dlRef.current?.url) URL.revokeObjectURL(dlRef.current.url);
    dlRef.current = null;
    const controller = new AbortController();
    abortRef.current = controller;
    setDl({ loaded: 0, total: 0 });
    setDlError("");
    try {
      const { blob, filename } = await owDownload(decodeURIComponent(wsEnc), file.path, {
        signal: controller.signal,
        fallbackName: file.name,
        onProgress: ({ loaded, total }) => setDl({ loaded, total }),
      });
      const url = URL.createObjectURL(blob);
      setDl({ done: true, filename, url, blob });
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      if (e?.name !== "AbortError") setDlError(`Tải lỗi: ${e.message}`);
      setDl(null);
    } finally {
      abortRef.current = null;
    }
  }

  function cancelDownload() {
    abortRef.current?.abort();
    abortRef.current = null;
    setDl(null);
  }

  // iOS chỉ cho "Lưu về Files" qua Share sheet — hiện nút này khi hỗ trợ.
  async function shareFile() {
    try {
      const ready = dl?.done ? dl : await (async () => {
        const r = await owDownload(decodeURIComponent(wsEnc), file.path, { fallbackName: file.name });
        return { done: true, ...r };
      })();
      const nav = navigator;
      const f = new File([ready.blob], ready.filename, { type: ready.blob.type || undefined });
      if (nav.canShare?.({ files: [f] })) {
        await nav.share({ files: [f], title: ready.filename });
        return;
      }
      const url = ready.url ?? URL.createObjectURL(ready.blob);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      if (e?.name !== "AbortError") setDlError(`Chia sẻ lỗi: ${e.message}`);
    }
  }

  useEffect(
    () => () => {
      abortRef.current?.abort();
      const url = dlRef.current?.url;
      if (url) URL.revokeObjectURL(url);
    },
    []
  );

  const dlBusy = !!dl && !dl.done;
  const dlLabel = !dl
    ? "Tải về"
    : dl.done
      ? "Tải lại"
      : dl.total
        ? `Đang tải ${Math.round((dl.loaded / dl.total) * 100)}% (${formatBytes(dl.loaded)}/${formatBytes(dl.total)})`
        : `Đang tải ${formatBytes(dl.loaded)}…`;

  return (
    <>
      <div class="page-head">
        <div class="page-actions" style="margin-left:auto">
          {dlBusy ? (
            <button class="btn small ghost btn-icon" onClick={cancelDownload}>
              Hủy
            </button>
          ) : (
            <button class="btn small ghost btn-icon" onClick={downloadFile}>
              <DownloadIcon size={16} /> {dlLabel}
            </button>
          )}
          <button class="btn small ghost btn-icon" onClick={shareFile}>
            Chia sẻ
          </button>
          {file.kind === "text" && (
            <button class="btn small" disabled={!dirty || saving} onClick={save}>
              {saving ? "Đang lưu…" : dirty ? "Lưu" : "Đã lưu"}
            </button>
          )}
        </div>
      </div>

      <div class="crumbs mono">{file.path}</div>
      {error && <Banner kind="err">{error}</Banner>}
      {dlError && <Banner kind="err" actionLabel="Thử lại" onAction={downloadFile}>{dlError}</Banner>}
      {dlBusy && dl.total > 0 && (
        <progress value={dl.loaded} max={dl.total} style="width:100%;height:6px" aria-label="Tiến trình tải file" />
      )}

      {file.kind === "text" && content === null && !error && <Loading />}

      {file.kind === "text" && content !== null && (
        <div class="file-editor">
          <textarea
            aria-label={`Nội dung file ${file.name}`}
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
          <img src={downloadUrl} alt={file.name} width="800" style="max-width:100%;height:auto;border-radius:12px;border:1px solid var(--border)" />
        </div>
      )}

      {file.kind === "pdf" && (
        <iframe
          title={`Xem trước ${file.name}`}
          src={downloadUrl}
          style="width:100%;height:70vh;border-radius:12px;border:1px solid var(--border);background:var(--bg-raised)"
        />
      )}

      {file.kind === "binary" && (
        <Empty
          title="File nhị phân"
          hint={`Bấm "Tải về" để tải ${file.name} về điện thoại.`}
          actionLabel="Tải về"
          onAction={downloadFile}
        />
      )}
    </>
  );
}
