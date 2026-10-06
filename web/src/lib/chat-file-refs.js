// File agent nhắc tới trong tin nhắn — TÁCH THUẦN khỏi pages/chat.jsx để test
// được bằng `node --test` (chat.jsx là JSX, không import nổi trong Node).
//
// Engine không có part "file" riêng: agent chỉ NHẮC đường dẫn trong text
// (code `...`, đường dẫn Windows, tương đối) và trong input/output của tool
// write/edit/bash. Module này quét ra danh sách đường dẫn để UI hiện thẻ bấm
// mở/tải ngay trong chat.
import { FILE_HINT_EXT } from "./markdown.js";

export function baseNameOf(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);
}

/** Tìm các đường dẫn file trong text (code `...`, đường dẫn Windows, tương đối). */
export function findFileRefsInText(text) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const clean = String(p).replace(/^[<"'“”'(\[]+|[>"'“”'().,;:\]\)]+$/g, "").trim();
    if (!clean || seen.has(clean)) return;
    if (!FILE_HINT_EXT.test(clean)) return;
    if (clean.length > 260) return;
    seen.add(clean);
    out.push({ path: clean, name: baseNameOf(clean) });
  };
  const src = String(text ?? "");
  // 1. Đoạn code `duong/dan/file.ext`
  for (const m of src.matchAll(/`([^`\n]{1,180})`/g)) push(m[1]);
  // 2. Đường dẫn Windows C:\... hoặc C:/...
  for (const m of src.matchAll(/[A-Za-z]:[\\/][^\s"'“”'()[\]<>]{1,180}/g)) push(m[0]);
  // 3. Đường dẫn tương đối có thư mục: thu-muc/file.ext
  for (const m of src.matchAll(/(?:^|[\s"'“”'(\[])([\w\-.À-ỹ]+(?:[\\/][\w\-.À-ỹ ]+)+\.\w{2,5})\b/g)) push(m[1]);
  return out;
}

/** Gom mọi file agent nhắc tới trong 1 message (text + tool input/output).
 * Trả tối đa 5 đường dẫn — hàng file là phụ, không chiếm chỗ cả màn. */
export function collectFileRefs(parts) {
  const out = [];
  const seen = new Set();
  const add = (ref) => {
    if (!ref || seen.has(ref.path)) return;
    seen.add(ref.path);
    out.push(ref);
  };
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      for (const ref of findFileRefsInText(part.text)) add(ref);
    }
    if (part.type === "tool") {
      const blob = JSON.stringify(part.state?.input ?? {});
      for (const m of blob.matchAll(/"filePath"\s*:\s*"([^"]{1,200})"/g)) {
        const p = m[1];
        if (FILE_HINT_EXT.test(p)) add({ path: p, name: baseNameOf(p) });
      }
      const output = part.state?.output;
      if (typeof output === "string") {
        for (const ref of findFileRefsInText(output.slice(0, 4000))) add(ref);
      }
    }
  }
  return out.slice(0, 5);
}

/** Bóc thư mục cha khỏi đường dẫn (nhận cả `C:\...`); gốc/tương đối trần → "". */
export function dirOf(p) {
  const clean = String(p).replace(/^[A-Za-z]:[\\/]/, "").replace(/\\/g, "/");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "" : clean.slice(0, i);
}

/** Đường dẫn file trong workspace → link mở trong app.
 *
 *  KHÔNG dựng URL có token: `<a>`/`<img>` không set được header Authorization,
 *  bản cũ dán `?_t=<token>` vào href — chìa đó nằm trong history trình duyệt
 *  và trong Referer của mọi request sau. Nay link trỏ thẳng trang Files (cùng
 *  chỗ hàng file trong chat mở) nên không cần auth trên URL.
 *
 *  `path` giữ nguyên để engine nhận (nó nhận cả `C:\...`); bản `/` chỉ dùng
 *  để bóc thư mục cha cho tham số `path` của hash. */
export function makeFileHref(wsId) {
  if (!wsId) return null;
  return (path) => {
    const slash = String(path).replace(/\\/g, "/");
    const cut = slash.lastIndexOf("/");
    const dir = cut > 0 ? slash.slice(0, cut) : "";
    return `#/ws/${encodeURIComponent(wsId)}/files?path=${encodeURIComponent(dir)}&open=${encodeURIComponent(path)}`;
  };
}
