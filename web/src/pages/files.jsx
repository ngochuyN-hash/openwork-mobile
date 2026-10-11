import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ow, owDownload, owUploadFile, owWriteFile } from "../api.js";
import { formatBytes, unwrap } from "../lib/format.js";
import { blobUrlFor } from "../lib/blob-preview.js";
import { createDownloadTask } from "../lib/download-task.js";
import { errorSentence, isUnpaired } from "../lib/net.js";
import { createLoadGuard } from "../lib/load-guard.js";
import { DownloadIcon, FileIcon, FolderIcon, ImageIcon, RefreshIcon, UploadIcon } from "../components/icons.jsx";
import { Banner, Empty, Loading } from "../components/ui.jsx";
import {
  crumbPaths, fileNameOf, isImageName, kindOf, parentDirOf, textTooLarge, uploadSummary,
} from "../lib/file-viewer.js";

/** `decodeURIComponent` nem URIError voi chuoi `%` hong — hash do nguoi dung
 *  link cu go tay co the hong, va nem ra trong effect la SAP CA TRANG. */
function safeDecode(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
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
  // Chống race khi bấm nhanh 2 thư mục: lib/load-guard hủy fetch cũ + đếm lượt
  // (một primitive chung với home/search/sessions) — kết quả về trễ của thư mục
  // CŨ không được vẽ dưới breadcrumb MỚI.
  const guardRef = useRef(null);
  if (!guardRef.current) guardRef.current = createLoadGuard();
  // Tang moi moi khi nguoi dung doi workspace / hash tu ngoai. Nam trong deps
  // cua effect nap ben duoi: neu chi dua vao `path`, truong hop doi workspace
  // ma `path` trung (rat de: ca hai deu o "src") se khong co lan nap nao chay
  // lai sau khi ta xoa `entries` -> man hinh ket o "Dang tai..." vinh vien.
  const [navNonce, setNavNonce] = useState(0);

  const load = useCallback(
    async (dir) => {
      const token = guardRef.current.begin();
      try {
        const payload = await ow(`/workspace/${wsEnc}/opencode/file?path=${encodeURIComponent(dir)}`, {
          signal: token.signal,
        });
        if (guardRef.current.stale(token)) return null; // đã có lượt load mới hơn — bỏ kết quả stale
        const nodes = unwrap(payload) ?? [];
        const dirs = nodes.filter((n) => n.type === "directory").sort((a, b) => a.name.localeCompare(b.name));
        const files = nodes.filter((n) => n.type !== "directory").sort((a, b) => a.name.localeCompare(b.name));
        setEntries([...dirs, ...files]);
        setError("");
        return null; // không có lỗi
      } catch (e) {
        if (token.signal.aborted || e?.name === "AbortError") return null;
        if (guardRef.current.stale(token)) return null;
        const msg = errorSentence(e);
        setError(msg);
        setEntries([]);
        return msg; // để caller ghép lỗi của mình vào, không đè mất lỗi nạp
      }
    },
    [wsEnc]
  );

  // Rời trang thì hủy fetch đang treo (nếu có).
  useEffect(() => () => guardRef.current.invalidate(), []);

  // `load` nằm trong deps: đổi workspace (`wsEnc` đổi -> useCallback sinh lại)
  // mà effect chỉ nghe `path` thì trang vẫn vẽ danh sách của workspace CŨ, và
  // mọi nút (tải lên, mở file) lại gọi sang workspace mới.
  useEffect(() => {
    load(path);
  }, [path, load, navNonce]);

  // Nhảy từ chat (bấm hàng file): hash có ?open=<path> — đường dẫn đã được
  // chat stat xác thực (engine nhận cả dạng tuyệt đối) — thì mở thẳng viewer.
  //
  // CHẠY TRƯỚC effect hash-sync (thứ tự khai báo) để đọc được `open=`; hash
  // sync ở dưới replaceState lại thành hash KHÔNG kèm open, nên tham số này tự
  // biến mất sau một nhịp — Back/Forward không mở lại file cũ.
  useEffect(() => {
    const m = /[?&]open=([^&]*)/.exec(location.hash);
    if (!m) return;
    const p = safeDecode(m[1]);
    if (!p) return;
    const name = fileNameOf(p);
    setOpened({ name, path: p, kind: kindOf(name) });
    // Agent thường nhắc tên TƯƠNG ĐỐI trong workspace (`README.md`) trong khi
    // file nằm ở thư mục con (`projects/ats-cv-toolkit/README.md`) — link mở
    // viewer thì báo "File not found" dù file có thật. Thử vài dạng đường dẫn
    // (y hệt hàng file trong chat) và chỉ dùng dạng nào engine thật sự có.
    //
    // Không dùng cơ chế "mở thẳng" của hàng chat: nó dò trước rồi mới điều
    // hướng, còn ở đây người dùng ĐÃ ở trang Files — chỉ cần thay `path` của
    // viewer sau khi dò trúng.
    let cancel = false;
    const controller = new AbortController();
    (async () => {
      const slash = p.replace(/\\/g, "/");
      const candidates = [p];
      const cut = slash.indexOf("/");
      if (cut > 0) candidates.push(slash.slice(cut + 1)); // bỏ thư mục dẢ ĐẦU
      for (const cand of candidates) {
        if (cand === p) continue;
        try {
          const info = await ow(`/workspace/${wsEnc}/files/stat?path=${encodeURIComponent(cand)}`, {
            signal: controller.signal,
          });
          if (cancel) return;
          if (info?.exists) {
            const name2 = fileNameOf(cand);
            setOpened({ name: name2, path: cand, kind: kindOf(name2) });
            return;
          }
        } catch {
          /* thử ứng viên tiếp theo */
        }
      }
    })();
    return () => {
      cancel = true;
      controller.abort();
    };
  }, []);

  // Đồng bộ `path` khi hash BỊ ĐỔI TỪ NGOÀI (Back/Forward, đổi workspace, hoặc
  // bấm link files khác trong khi trang đang mở). `path` trong state là nguồn
  // vẽ, nên bỏ qua thì effect hash-sync sẽ GHI ĐÈ hash ngược lại — URL nói
  // ?path=B mà màn hình vẫn là A, và Back thành nút chết.
  //
  // Khoá gồm CẢ wsId: đổi workspace mà path trùng nhau (rất dễ — cả hai đều ở
  // "src") thì so mỗi `route.path` sẽ tưởng không có gì đổi và giữ lại danh
  // sách + viewer của workspace CŨ trong khi mọi nút đã trỏ sang máy mới.
  //
  // An toàn với setPath của chính trang: setPath gọi replaceState nên KHÔNG bắn
  // hashchange, `route` không đổi -> effect này không chạy -> không lặp.
  const routeKey = `${wsId}\u0000${route.path ?? ""}`;
  const lastSynced = useRef(routeKey);
  useEffect(() => {
    if (routeKey === lastSynced.current) return;
    lastSynced.current = routeKey;
    setPath(route.path ?? "");
    setNavNonce((v) => v + 1);
    setEntries(null); // xoá danh sách cũ, không để hiện dưới tên workspace mới
    setOpened(null); // tương tự với viewer đang mở
    setError("");
    setUploadNote("");
  }, [routeKey]);

  useEffect(() => {
    // giữ path trong hash để back/forward hoạt động
    const target = `#/ws/${wsEnc}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`;
    if (location.hash !== target) history.replaceState(null, "", target);
  }, [path]);

  function openFile(node) {
    const name = String(node.name ?? "");
    // `path` (tương đối so với workspace) là thứ engine nhận; `absolutePath` là
    // dự phòng cho shape cũ. THIẾU CẢ HAI thì đừng mở viewer với path
    // `undefined` — mọi request sau đó đều hỏng với một thông báo khó hiểu.
    const target = node.path ?? node.absolutePath ?? "";
    if (!target) {
      setError(`Could not read path of "${name}" — reload file list.`);
      return;
    }
    const shown = name || fileNameOf(target);
    setOpened({ name: shown, path: target, kind: kindOf(shown) });
  }

  async function uploadPicked(fileList) {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setUploading(true);
    setUploadNote("");
    setError("");
    let done = 0;
    const failed = [];
    for (const file of files) {
      setUploadNote(`Uploading ${done + failed.length + 1}/${files.length}: ${file.name}…`);
      try {
        await owUploadFile(wsId, path, file);
        done += 1;
      } catch {
        // Gom TÊN file lỗi thay vì `setError` từng lần: bản cũ bị ghi đè nên
        // upload 5 file hỏng 2 chỉ còn lỗi file CUỐI, và dòng "đã tải lên 3/5"
        // bị ẩn vì Banner ưu tiên error. Xem uploadSummary.
        failed.push(file.name);
      }
    }
    setUploading(false);
    const summary = uploadSummary(done, failed);
    setUploadNote(summary.note);
    // `load` tự `setError("")` khi thành công — gán lỗi upload TRƯỚC rồi gọi
    // load là lỗi bị xoá ngay sau một nhịp, người dùng thấy "Đã tải lên 3/5"
    // mà không thấy 2 file nào hỏng. Phải chờ load xong rồi mới gán lỗi.
    const loadErr = await load(path);
    // Gộp hai lỗi: nạp lại danh sách hỏng VÀ có file upload hỏng là hai chuyện
    // khác nhau, hiện một là mất một.
    if (summary.error) {
      setError(loadErr ? `${summary.error} Directory could not be reloaded: ${loadErr}` : summary.error);
    }
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

  // Breadcrumb dựng từ các đường dẫn TÍCH LUỸ (lib) thay vì `slice().join("/")`
  // rải ở hai chỗ: giữ đúng một nguồn sự thật, và hàng ".." dùng `parentDirOf`
  // nên không còn trường hợp `crumbs.slice(0,-1).join("/")` ra chuỗi rỗng/lệch
  // khi path có dấu gạch chéo cuối.
  const crumbLabels = path.split(/[\\/]+/).filter(Boolean);
  const crumbs = crumbPaths(path);
  const parent = parentDirOf(path);

  return (
    <>
      <div class="page-head">
        <div class="page-actions" style="margin-left:auto">
          <button type="button" class="btn small ghost btn-icon" disabled={uploading} onClick={() => uploadRef.current?.click()}>
            <UploadIcon size={16} /> {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabindex="-1"
            onChange={(e) => {
              uploadPicked(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
          <button type="button" class="btn small ghost btn-icon" aria-label="Reload file list" onClick={() => load(path)}>
            <RefreshIcon size={16} />
          </button>
        </div>
      </div>

      <nav class="crumbs" aria-label="Folder path">
        <a href="#" onClick={(e) => { e.preventDefault(); setPath(""); }}>root</a>
        {crumbs.map((crumb, i) => (
          <span key={crumb}>
            {" / "}
            <a
              href="#"
              aria-current={i === crumbs.length - 1 ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setPath(crumb);
              }}
            >
              {crumbLabels[i]}
            </a>
          </span>
        ))}
      </nav>

      {error && <Banner kind="err" actionLabel="Retry" onAction={() => load(path)}>{error}</Banner>}
      {/* KHÔNG điều kiện `!error`: upload 3/5 thành công + 2 file hỏng phải hiện
          CẢ HAI dòng. Bản cũ ẩn dòng thông báo khi có lỗi, nên người dùng mất
          thông tin "đã tải được mấy file" đúng lúc nó quan trọng nhất. */}
      {uploadNote && <Banner kind="warn" actionLabel="Dismiss" onAction={() => setUploadNote("")}>{uploadNote}</Banner>}
      {entries === null && <Loading />}

      {path && (
        <div
          class="file-row"
          role="button"
          tabIndex={0}
          aria-label="Go to parent directory"
          onClick={() => setPath(parent)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPath(parent);
            }
          }}
        >
          <span class="icon"><FolderIcon /></span>
          <span class="name" style="color:var(--text-dim)">..</span>
        </div>
      )}

      {entries?.map((node) => {
        const isDir = node.type === "directory";
        const label = String(node.name ?? "");
        return (
          <div
            class="file-row"
            key={node.path ?? label}
            role="button"
            tabIndex={0}
            aria-label={`${isDir ? "Open folder" : "Open file"} ${label}`}
            onClick={() => (isDir ? setPath(node.path ?? node.absolutePath ?? "") : openFile(node))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                isDir ? setPath(node.path ?? node.absolutePath ?? "") : openFile(node);
              }
            }}
          >
            <span class="icon">
              {isDir ? <FolderIcon /> : isImageName(label) ? <ImageIcon /> : <FileIcon />}
            </span>
            <span class="name">{label}</span>
            {!isDir && node.size != null && (
              <span class="size">{formatBytes(node.size)}</span>
            )}
          </div>
        );
      })}

      {entries?.length === 0 && !error && (
        <Empty title="Folder is empty" hint="Upload files to get started." actionLabel="Upload file" onAction={() => uploadRef.current?.click()} />
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // edited mới nhất: `save()` đọc qua ref để so "vừa lưu" với cái người dùng
  // đang gõ, không đọc closure cũ (xem save()).
  const editedRef = useRef(edited);
  editedRef.current = edited;

  // Tham số tải GẦN NHẤT: task tạo MỘT lần cho đời component, callback đọc qua
  // ref để lượt tải luôn đi đúng file ĐANG mở — `file` có thể đổi mà component
  // không remount (mở link ?open= khác khi viewer đang mở).
  const downloadArgsRef = useRef(null);
  downloadArgsRef.current = { wsId: decodeURIComponent(wsEnc), path: file.path, name: file.name };
  // Vòng đời tải/chi sẻ/huỷ/revoke nằm ở lib/download-task.js (node --test được):
  // controller abort + token chống race huỷ/bấm-lại + revoke URL done + URL share
  // riêng + cleanup lúc unmount — bản cũ nhốt cả bốn mối trong JSX với 0 test,
  // comment ghi lại 2 leak thật và 1 bug "hủy chết".
  const taskRef = useRef(null);
  if (!taskRef.current) {
    taskRef.current = createDownloadTask({
      download: ({ signal, onProgress }) => {
        const args = downloadArgsRef.current;
        return owDownload(args.wsId, args.path, { signal, onProgress, fallbackName: args.name });
      },
      onChange: setDl,
      onError: (e) => setDlError(`Download failed: ${e.message}`),
      onSaved: ({ filename, url }) => {
        // <a download> gốc hay bị Safari/PWA bỏ qua (mở file trong tab thay vì
        // lưu) — blob sẵn sàng thì kích link thật. DOM là việc của trang, task
        // chỉ báo xong.
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    });
  }
  const task = taskRef.current;
  // Rời viewer: huỷ lượt đang tải + revoke MỌI URL (done + share) — lib làm.
  useEffect(() => () => task.dispose(), []);

  // Nút Đóng mượn topbar (ghim cố định): báo lên App qua event nội bộ, gửi 1 lần lúc mở.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("owm:topback", { detail: { label: "Close", onBack: () => closeRef.current() } }));
    return () => window.dispatchEvent(new CustomEvent("owm:topback", { detail: null }));
  }, []);

  // Nạp nội dung file text. `cancel` chặn setState sau unmount: bấm "Đóng" khi
  // request còn đang bay là setState trên component đã bị bỏ (Preact không nổ,
  // nhưng nó giữ nguyên request không cần thiết và dễ sinh race sau này).
  // `loadNonce` buộc effect chạy lại khi bấm "Thử lại" sau khi lần đầu lỗi.
  //
  // File quá lớn để mở trong trình soạn đi vào `blocked`, KHÔNG phải `error`:
  // `error` vẫn render <textarea> với `content = ""`, tức là một lần bấm Lưu là
  // ghi đè file thật bằng nội dung rỗng. `blocked` thì không có ô gõ nào.
  const [loadNonce, setLoadNonce] = useState(0);
  const [blocked, setBlocked] = useState("");
  useEffect(() => {
    if (file.kind !== "text") return undefined;
    let cancel = false;
    (async () => {
      try {
        const res = await ow(`/workspace/${wsEnc}/files/raw?path=${encodeURIComponent(file.path)}`, { raw: true });
        if (cancel) return;
        if (!res.ok) {
          // Engine trả JSON lỗi — đừng nhét nó vào làm nội dung file.
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            if (j?.message) msg = j.message;
          } catch {
            /* body không phải JSON — giữ HTTP status */
          }
          throw new Error(msg);
        }
        // CHẶN TRƯỚC khi đọc: `res.text()` nạp cả file vào RAM rồi đổ vào
        // <textarea>. File text 200MB (log, dump, csv) sẽ giết tab điện thoại
        // và không có cách nào phục hồi, kể cả nút Tải về. Engine có gửi
        // content-length nên chặn được gần như miễn phí.
        const declared = Number(res.headers?.get?.("content-length") ?? 0) || 0;
        const tooBig = textTooLarge(declared);
        if (tooBig) {
          setBlocked(tooBig);
          setContent(null);
          setEdited("");
          setError("");
          return;
        }
        const text = await res.text();
        if (cancel) return;
        // Chặn lần hai phòng khi engine KHÔNG gửi content-length (chunked).
        const lateTooBig = textTooLarge(text.length);
        if (lateTooBig) {
          setBlocked(lateTooBig);
          setContent(null);
          setEdited("");
          setError("");
          return;
        }
        setBlocked("");
        setContent(text);
        setEdited(text);
        setError("");
      } catch (e) {
        if (!cancel) setError(errorSentence(e));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [file.path, wsEnc, loadNonce]);

  // Xem trước ảnh/PDF: blob URL lấy bằng header Authorization. Bản cũ dán
  // `?_t=<token>` vào src — token lọt vào history trình duyệt và Referer. Chỉ
  // nạp khi thật sự cần (kind image/pdf); file text đã đi `ow(..., {raw:true})`.
  //
  // Khai báo SAU effect nạp text vì dùng `loadNonce` trong deps — đặt trước là
  // đọc biến trước khi khai báo (temporal dead zone), giết cả trang lúc mount.
  const [previewUrl, setPreviewUrl] = useState("");
  const previewable = file.kind === "image" || file.kind === "pdf";
  useEffect(() => {
    if (!previewable) {
      setPreviewUrl("");
      return undefined;
    }
    let cancel = false;
    setPreviewUrl("");
    blobUrlFor(decodeURIComponent(wsEnc), file.path).then(
      (url) => {
        if (!cancel) setPreviewUrl(url);
      },
      (e) => {
        if (cancel) return;
        // UNPAIRED = app mất chìa; App tự xử, đừng báo thêm lỗi file.
        if (isUnpaired(e)) return;
        setError(`Could not open "${file.name}": ${errorSentence(e) || "failed to load"}`);
      }
    );
    return () => {
      cancel = true;
    };
  }, [previewable, wsEnc, file.path, file.name, loadNonce]);

  async function save() {
    const text = editedRef.current;
    setSaving(true);
    setError("");
    try {
      await owWriteFile(decodeURIComponent(wsEnc), file.path, text);
      setContent(text);
      // Người dùng có thể gõ tiếp TRONG lúc đang lưu. So với bản gõ mới nhất
      // (đọc qua ref) chứ không setDirty(false) cứng: setDirty(false) khiến phần
      // sửa dở bị báo là "Đã lưu" và nút Lưu tắt -> mất thay đổi đó.
      setDirty(editedRef.current !== text);
    } catch (e) {
      setError(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Tải/chi sẻ/huỷ: toàn bộ máy trạng thái nằm trong `task`
  // (lib/download-task.js) — start() tự chặn bấm kép, tự revoke URL lượt trước,
  // tự im lặng với AbortError. Xong lượt thì onSaved ở trên kích <a download>.
  function downloadFile() {
    setDlError("");
    task.start();
  }

  function cancelDownload() {
    task.cancel();
  }

  // iOS chỉ cho "Lưu về Files" qua Share sheet — hiện nút này khi hỗ trợ.
  async function shareFile() {
    // Đang tải dở thì không chia sẻ: getForShare sẽ tải LẠI cùng file một lần
    // nữa — hai luồng đọc chung một đường dẫn, và nút Hủy chỉ nắm được luồng
    // của start(). Khoá nút thay vì để sinh thêm.
    if (task.busy()) return;
    try {
      const ready = await task.getForShare();
      const nav = navigator;
      const f = new File([ready.blob], ready.filename, { type: ready.blob.type || undefined });
      if (nav.canShare?.({ files: [f] })) {
        await nav.share({ files: [f], title: ready.filename });
        return;
      }
      // Không có Share sheet (desktop): mở tab. URL task tự quản — URL done
      // được dùng lại, URL riêng cho lần share task tự thu hồi lúc dispose.
      const url = ready.url ?? ready.ownedUrl;
      // window.open có thể bị chặn (popup blocker) vì đã await mất "user
      // activation" — trả về null. Báo lỗi thay vì im lặng. Chỉ báo khi URL là
      // của riêng lần share này; URL done thì nút Download vẫn còn đường mở.
      const win = window.open(url, "_blank", "noopener");
      if (!win && ready.ownedUrl) {
        setDlError("Browser blocked new window — tap Download to save file instead.");
      }
    } catch (e) {
      if (e?.name !== "AbortError") setDlError(`Share failed: ${e.message}`);
    }
  }

  const dlBusy = !!dl && !dl.done;
  const dlLabel = !dl
    ? "Download"
    : dl.done
      ? "Download again"
      : dl.total
        ? `Downloading ${Math.round((dl.loaded / dl.total) * 100)}% (${formatBytes(dl.loaded)}/${formatBytes(dl.total)})`
        : `Downloading ${formatBytes(dl.loaded)}…`;

  return (
    <>
      <div class="page-head">
        <div class="page-actions" style="margin-left:auto">
          {dlBusy ? (
            <button type="button" class="btn small ghost btn-icon" onClick={cancelDownload}>
              Cancel
            </button>
          ) : (
            <button type="button" class="btn small ghost btn-icon" onClick={downloadFile}>
              <DownloadIcon size={16} /> {dlLabel}
            </button>
          )}
          <button
            type="button"
            class="btn small ghost btn-icon"
            disabled={dlBusy}
            title={dlBusy ? "Downloading — cancel first if you want to share." : "Share file"}
            onClick={shareFile}
          >
            Share
          </button>
          {file.kind === "text" && content !== null && (
            <button type="button" class="btn small" disabled={!dirty || saving} onClick={save}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          )}
        </div>
      </div>

      <div class="crumbs mono">{file.path}</div>
      {/* Lỗi nạp file text có nút Thử lại: file có thể vừa được tạo trên máy
          tính, hoặc tunnel chết vài giây — bản cũ chỉ hiện dòng chữ đỏ, người
          dùng buộc phải đóng rồi mở lại. Với ảnh/PDF, "thử lại" có nghĩa là tải
          lại file (nút Thử lại của text chỉ nạp lại nội dung). */}
      {error && (
        <Banner
          kind="err"
          actionLabel="Retry"
          onAction={() => {
            setError(""); // nạp lại xong phải xoá lỗi cũ, không thì Banner đứng lại
            setLoadNonce((v) => v + 1);
          }}
        >
          {error}
        </Banner>
      )}
      {dlError && <Banner kind="err" actionLabel="Retry" onAction={downloadFile}>{dlError}</Banner>}
      {dlBusy && dl.total > 0 && (
        <progress value={dl.loaded} max={dl.total} style="width:100%;height:6px" aria-label="File download progress" />
      )}

      {file.kind === "text" && blocked && (
        <Empty title="File too large to open in editor" hint={blocked} actionLabel="Download" onAction={downloadFile} />
      )}

      {file.kind === "text" && !blocked && content === null && !error && <Loading />}

      {file.kind === "text" && !blocked && content !== null && (
        <div class="file-editor">
          <textarea
            aria-label={`Content of file ${file.name}`}
            value={edited}
            onInput={(e) => {
              setEdited(e.currentTarget.value);
              setDirty(e.currentTarget.value !== content);
            }}
            spellcheck={false}
          />
        </div>
      )}

      {/* `onError`: bản cũ không bắt lỗi ảnh — file bị xoá giữa lúc stat và
          lúc mở, hoặc chìa 401, chỉ ra một ảnh vỡ im lặng, người dùng tưởng app
          hỏng. Giờ hiện đúng lý do + nút tải lại. */}
      {file.kind === "image" && !error && previewUrl && (
        <div style="text-align:center">
          <img
            src={previewUrl}
            alt={file.name}
            width="800"
            style="max-width:100%;height:auto;border-radius:12px;border:1px solid var(--border)"
            onError={() => setError(`Failed to load image "${file.name}" — file may have been deleted or moved.`)}
          />
        </div>
      )}

      {file.kind === "image" && !error && !previewUrl && <Loading />}

      {/* PDF: chỉ gắn iframe khi blob URL đã sẵn — `src=""` làm trình duyệt
          tải lại chính trang app, tốn băng thông và có thể nhúng app vào
          chính nó. */}
      {file.kind === "pdf" && previewUrl && (
        <iframe
          title={`Preview ${file.name}`}
          src={previewUrl}
          style="width:100%;height:70vh;border-radius:12px;border:1px solid var(--border);background:var(--bg-raised)"
        />
      )}

      {file.kind === "pdf" && !previewUrl && !error && <Loading />}

      {file.kind === "binary" && (
        <Empty title="Binary file" actionLabel="Download" onAction={downloadFile} />
      )}
    </>
  );
}
