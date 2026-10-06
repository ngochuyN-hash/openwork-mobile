// Các mảnh render MỘT tin nhắn trong chat — tách khỏi pages/chat.jsx để
// ChatPage chỉ còn trạng thái phiên (stream/outbox/permission); phần "vẽ một
// tin" nằm ở đây. Không logic mới: cut-paste từ chat.jsx, giữ nguyên hành vi.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { blobUrlFor, ow } from "../api.js";
import { toolRowView, toolStatusVi, messageErrorOf } from "../lib/session-ops.js";
import { createMarkdownStream } from "../lib/markdown.js";
import { collectFileRefs, makeFileHref } from "../lib/chat-file-refs.js";
import { FileIcon, ToolIcon, ThoughtIcon, ChevronDownIcon } from "./icons.jsx";

// ---- Hàng thu gọn kiểu ZCode: tool + suy luận mặc định ĐÓNG, đúng một ----
// dòng (icon + tên + trạng thái + mũi tên), bấm mới xổ nội dung ra xem.
// Tiêu đề + tiền tố lấy từ toolRowView (lib/session-ops) — engine đặt title
// là câu lệnh bash dài, đổ nguyên ra là hàng tràn màn hình.

function ToolRow({ part }) {
  const v = toolRowView(part);
  // Trần hiển thị: transcript tool có khi cả trăm KB — cắt bớt cho điện thoại.
  const MAX = 20_000;
  return (
    <details class="fold-row tool-row">
      <summary>
        <ToolIcon size={14} />
        <span class="fold-title">{v.title || v.label}</span>
        <span class={`fold-status${v.status === "error" ? " err" : ""}${v.status === "running" ? " run" : ""}`}>
          {toolStatusVi(v.status)}
        </span>
        <ChevronDownIcon size={12} />
      </summary>
      <div class="fold-body">
        {v.input && <pre>{safeJson(v.input).slice(0, MAX)}</pre>}
        {v.body && <pre>{v.body.slice(0, MAX)}{v.body.length > MAX ? "\n… (truncated)" : ""}</pre>}
      </div>
    </details>
  );
}

function ThoughtRow({ part }) {
  const streaming = part.state?.status === "streaming";
  return (
    <details class="fold-row reasoning">
      <summary>
        <ThoughtIcon size={14} />
        <span class="fold-title">Reasoning</span>
        <span class={`fold-status${streaming ? " run" : ""}`}>{streaming ? "thinking…" : ""}</span>
        <ChevronDownIcon size={12} />
      </summary>
      <div class="fold-body reasoning-body">{part.text}</div>
    </details>
  );
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Hàng file trong chat: CHỈ một dòng chữ mảnh (icon + tên + mũi tên) như
 * các hàng tool/suy luận — bấm hàng mới nhảy sang Files mở viewer xem/tải,
 * chat không bị thẻ nút chiếm chỗ. */
function FileRefCard({ refPath, name, wsId }) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const base = `/workspace/${encodeURIComponent(wsId)}`;

  // Agent hay nhắc đường dẫn tuyệt đối Windows (C:\...) hoặc lấy gốc theo ổ
  // đĩa (Persona/...), còn API file hiểu đường dẫn tương đối trong workspace
  // (có khi gốc workspace là thư mục con) — thử cả ba dạng, cái nào có thì dùng.
  function candidates() {
    const out = [refPath];
    const m = /^[A-Za-z]:[\\/]/.exec(refPath);
    let p = refPath;
    if (m) {
      p = refPath.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
      out.push(p);
    } else {
      p = refPath.replace(/\\/g, "/");
    }
    const cut = p.indexOf("/");
    if (cut > 0) out.push(p.slice(cut + 1));
    return out;
  }

  async function open() {
    if (busy) return;
    setBusy(true);
    setMissing(false);
    try {
      let found = "";
      for (const p of candidates()) {
        try {
          // stat KHÔNG ném lỗi khi file thiếu — trả 200 {exists:false}, phải
          // đọc trường exists chứ đừng coi "không ném" là có file.
          const info = await ow(`${base}/files/stat?path=${encodeURIComponent(p)}`);
          if (info?.exists) {
            found = p;
            break;
          }
        } catch {
          /* thử ứng viên tiếp theo */
        }
      }
      if (!found) {
        setMissing(true);
        return;
      }
      // Giao diện xem/tải là trang Files mở thẳng viewer cho file này.
      // Truyền NGUYÊN path vừa stat được (engine nhận cả dạng tuyệt đối) —
      // bóc chữ ổ đĩa ra là viewer dính file_not_found (sai gốc tương đối).
      const norm = String(found).replace(/\\/g, "/");
      const cut = norm.lastIndexOf("/");
      const dir = cut > 0 ? norm.slice(0, cut) : "";
      location.hash = `#/ws/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(dir)}&open=${encodeURIComponent(found)}`;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="file-row">
      <div
        class="file-row-hit"
        role="button"
        tabindex="0"
        aria-label={`Open ${name} in Files`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        <FileIcon size={14} />
        <span class="file-row-name">{name}</span>
        {busy ? (
          <span class="file-row-hint">opening…</span>
        ) : (
          <span class="file-row-chev" aria-hidden="true"><ChevronDownIcon size={12} /></span>
        )}
      </div>
      {missing && (
        <div class="file-row-miss">This file is not in the workspace (the agent may have written it elsewhere).</div>
      )}
    </div>
  );
}

export function MessageBubble({ message, wsId, onMenu }) {
  // Shape engine: {info:{id,role,time,...}, parts:[...]} - fallback cho cả shape phẳng
  const role = message.info?.role ?? message.role;
  if (role !== "user" && role !== "assistant") return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  // Memo hoá: `parts` chỉ là object mới khi message THẬT sự đổi, còn mỗi
  // frame streaming lại tạo props object mới cho mọi bubble. Không memo thì
  // cả transcript quét lại file refs mỗi frame — đo được 7.4 ms/frame ở 200
  // tin, gấp ~8 lần cả phần markdown.
  const files = useMemo(() => (role === "assistant" ? collectFileRefs(parts) : []), [role, parts]);
  // Lượt chạy hỏng: engine để `parts` rỗng và ghi lỗi ở `info.error`. Không hiện
  // nó thì người dùng chỉ thấy tin đã gửi rồi im lặng — đúng cái kiểu lỗi
  // khó chịu nhất, vì không có gì để báo cáo là hỏng.
  const errorText = messageErrorOf(message);
  // Chạm vào tin để mở menu thao tác; bỏ qua bấm vào link/nút bên trong để
  // không cướp mất thao tác mở file hay bấm tool.
  const openMenu = (e) => {
    if (!onMenu) return;
    if (e.target?.closest?.("a,button,summary,[role='button'],input,details")) return;
    onMenu(message);
  };
  return (
    <div class={`msg ${role}`} onClick={openMenu}>
      {errorText && (
        <div class="msg-error" role="alert">
          <strong>The agent reported an error</strong>
          <span>{errorText}</span>
        </div>
      )}
      {parts.map((part, i) => {
        if (part.type === "text") {
          // Tin user giữ text thuần — không đi qua markdown, vừa đúng hành vi
          // cũ vừa khỏi chạy lexer/render rồi bỏ kết quả.
          if (role === "user") return <span key={i} class="msg-text">{part.text}</span>;
          return <MarkdownText key={i} text={part.text} wsId={wsId} />;
        }
        if (part.type === "tool") {
          return <ToolRow key={i} part={part} />;
        }
        if (part.type === "reasoning" && part.text) {
          return <ThoughtRow key={i} part={part} />;
        }
        return null;
      })}
      {files.map((f) => (
        <FileRefCard key={f.path} refPath={f.path} name={f.name} wsId={wsId} />
      ))}
    </div>
  );
}

/** Markdown của bubble assistant, dùng chung engine `marked` + GFM với
 *  OpenWork desktop (lib/markdown.js): bảng, cột số căn phải, bold, heading,
 *  link, blockquote.
 *
 *  Bộ render tăng dần giữ nguyên HTML của block đã chạy xong, vì chat flush
 *  theo frame — parse lại cả message mỗi frame là O(n²). */
function MarkdownText({ text, wsId }) {
  const fileHref = useMemo(() => makeFileHref(wsId), [wsId]);
  const stream = useMemo(() => createMarkdownStream({ fileHref }), [fileHref]);
  const html = useMemo(() => stream.render(text), [stream, text]);
  const rootRef = useRef(null);
  const tableScroll = useRef([]);

  // Gán innerHTML phá hủy hết node con, nên bảng đang được vuốt ngang sẽ
  // nhảy về cột đầu MỖI frame lúc agent còn gõ. Chụp lại scrollLeft lúc
  // render (trước khi DOM đổi — tương đương getSnapshotBeforeUpdate) rồi
  // trả lại sau khi Preact ghi innerHTML.
  if (rootRef.current) {
    tableScroll.current = [...rootRef.current.querySelectorAll(".md-table-wrap")].map((n) => n.scrollLeft);
  }
  useLayoutEffect(() => {
    const wraps = rootRef.current ? rootRef.current.querySelectorAll(".md-table-wrap") : [];
    wraps.forEach((node, i) => {
      if (tableScroll.current[i]) node.scrollLeft = tableScroll.current[i];
    });
  }, [html]);

  // Ảnh trong workspace render ra `<img data-owm-file="đường/dẫn">` CHƯA có
  // `src` (xem markdown.js): `<img>` không set được header nên không thể gắn
  // URL có token. Ở đây fetch bằng header rồi gắn `blob:` — token không bao
  // giờ rời JS.
  //
  // innerHTML bị gán lại mỗi frame lúc stream nên node `<img>` là node MỚI:
  // phải quét lại sau MỖI lần html đổi. Node đã có `src` (đã hydrate) thì
  // bỏ qua — `blobCacheKey` cũng chống việc tải lại cùng một file.
  const imgAlive = useRef(true);
  useEffect(() => {
    imgAlive.current = true;
    return () => {
      imgAlive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wsId || !rootRef.current) return;
    const nodes = [...rootRef.current.querySelectorAll("img[data-owm-file]")].filter((n) => !n.getAttribute("src"));
    if (!nodes.length) return;
    for (const node of nodes) {
      const path = node.getAttribute("data-owm-file");
      blobUrlFor(wsId, path).then(
        (url) => {
          // Node có thể đã bị innerHTML thay mới (stream) hoặc component đã
          // unmount — gắn src vào node chết là vô nghĩa, và vào node của
          // message khác là hiện ảnh sai.
          if (!url || !imgAlive.current || !node.isConnected) return;
          node.setAttribute("src", url);
        },
        () => {
          // Ảnh hỏng: để `alt` của node hiện thay vì im lặng — người dùng
          // vẫn thấy tên/tin nhắn ảnh và có thể bấm link bọc nó để mở Files.
          if (imgAlive.current && node.isConnected) node.setAttribute("data-owm-img-error", "1");
        }
      );
    }
  }, [html, wsId]);

  if (!text) return null;
  return <div class="msg-md" ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} />;
}
