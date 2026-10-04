// Render markdown của bubble chat — cùng engine `marked` + GFM mà OpenWork
// desktop dùng, nên bảng/cột số/bold/heading hiện giống hệt bản gốc.
//
// Vì sao không tự tách dòng như trước: markdown table là KHỐNG cấp khối
// (`| a | b |` + `| --- | --- |`), tách từng dòng thì chỉ còn text có dấu
// gạch dọc, không bao giờ có thẻ `<table>` để CSS bắt.
//
// An toàn: HTML thô trong markdown bị ESCAPE (không passthrough như desktop),
// và href chỉ qua `safeHref` — nên không cần DOMPurify. Đường dẫn file nội bộ
// đi qua `fileHref` của caller nên không lọt scheme lạ.

import { Marked } from "marked";

/** Hậu tố file hay gặp khi agent nhắc tới trong văn bản. */
export const FILE_HINT_EXT =
  /\.(txt|md|markdown|json|jsonc|csv|tsv|log|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|ico|svg|avif|mp4|mp3|wav|zip)\b/i;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

/** Chỉ cho http/https/mailto và đường dẫn tương đối — `javascript:` thành `#`. */
export function safeHref(href) {
  const trimmed = String(href ?? "").trim();
  if (!trimmed) return "#";
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) return trimmed;
  } catch {
    return "#";
  }
  return "#";
}

function isExternalHref(href) {
  return /^(?:https?:|mailto:|wss?:|tel:)/i.test(String(href ?? "").trim());
}

/** Đường dẫn `thu-muc/ten.ext` hoặc `C:\...` trong text thô → link mở/tải. */
function linkifyPaths(escapedText, fileHref) {
  if (typeof fileHref !== "function") return escapedText;
  let out = escapedText;
  const windows = /[A-Za-z]:[\\/][^\s"'“”'()[\]<>]{1,180}/g;
  const relative = /(^|[\s"'“”'(\[])([\w\-.]+(?:[\\/][\w\-.]+)+\.\w{2,5})\b/g;
  out = out.replace(windows, (m) => wrapPath(m, m, fileHref));
  out = out.replace(relative, (m, lead, path) => `${lead}${wrapPath(path, path, fileHref)}`);
  return out;
}

function wrapPath(display, path, fileHref) {
  let href;
  try {
    href = fileHref(path);
  } catch {
    return display;
  }
  if (!href) return display;
  return `<a class="md-file" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${display}</a>`;
}

function buildMarked({ fileHref } = {}) {
  return new Marked({
    gfm: true,
    breaks: false,
    // HTML thô coi như chữ — không phải passthrough.
    renderer: {
      html(token) {
        return escapeHtml(token.text);
      },
      paragraph({ tokens }) {
        return `<p>${this.parser.parseInline(tokens)}</p>`;
      },
      heading({ tokens, depth }) {
        const d = Math.min(Math.max(depth, 1), 6);
        return `<h${d}>${this.parser.parseInline(tokens)}</h${d}>`;
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const start = token.ordered && typeof token.start === "number" && token.start !== 1 ? ` start="${token.start}"` : "";
        return `<${tag}${start}>${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
      },
      listitem(item) {
        // `loose` quyết định có bọc <p> trong <li> không: list gọn thì để
        // chữ nằm thẳng trong ô, list rời (có dòng trống) thì mới tái đoạn.
        return `<li>${this.parser.parse(item.tokens, item.loose)}</li>`;
      },
      blockquote({ tokens }) {
        return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
      },
      code({ text, lang }) {
        const language = String(lang ?? "").trim().split(/\s+/)[0] ?? "";
        const cls = language ? ` class="language-${escapeAttribute(language)}"` : "";
        return `<pre class="md-code"><code${cls}>${escapeHtml(text)}</code></pre>`;
      },
      codespan({ text }) {
        const path = typeof fileHref === "function" && FILE_HINT_EXT.test(text) ? text : null;
        if (path) {
          let href = "";
          try {
            href = fileHref(path);
          } catch {
            href = "";
          }
          if (href) {
            return `<a class="md-file" href="${escapeAttribute(href)}" target="_blank" rel="noreferrer"><code>${escapeHtml(text)}</code></a>`;
          }
        }
        return `<code>${escapeHtml(text)}</code>`;
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        if (!isExternalHref(href) && typeof fileHref === "function" && FILE_HINT_EXT.test(href)) {
          let local = "";
          try {
            local = fileHref(href);
          } catch {
            local = "";
          }
          if (local) {
            return `<a class="md-file" href="${escapeAttribute(local)}" target="_blank" rel="noreferrer"${titleAttr}>${label}</a>`;
          }
        }
        return `<a href="${escapeAttribute(safeHref(href))}"${titleAttr} target="_blank" rel="noreferrer noopener">${label}</a>`;
      },
      image({ href, title, text }) {
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        return `<a href="${escapeAttribute(safeHref(href))}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(safeHref(href))}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async"></a>`;
      },
      // Bọc bảng trong hộp cuộn ngang: cột số trên điện thoại phải trượt được,
      // không bị bóp về 0 và đọc lối dấu `|` chồng lên nhau.
      table(token) {
        const header = token.header.map((cell) => this.tablecell({ ...cell, header: true })).join("");
        const body = token.rows
          .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") }))
          .join("");
        return `<div class="md-table-wrap"><table class="md-table"><thead>${this.tablerow({ text: header })}</thead><tbody>${body}</tbody></table></div>`;
      },
      tablerow({ text }) {
        return `<tr>${text}</tr>`;
      },
      tablecell({ tokens, header, align }) {
        const tag = header ? "th" : "td";
        const style = align ? ` style="text-align:${align}"` : "";
        return `<${tag}${style}>${this.parser.parseInline(tokens)}</${tag}>`;
      },
      del({ tokens }) {
        return `<del>${this.parser.parseInline(tokens)}</del>`;
      },
      hr() {
        return `<hr>`;
      },
      text(token) {
        if (token.tokens) return this.parser.parseInline(token.tokens);
        return linkifyPaths(escapeHtml(token.text), fileHref);
      },
    },
  });
}

/** Markdown → HTML cho một message đã xong. */
export function renderMarkdownHtml(text, options) {
  const source = String(text ?? "").replace(/\r\n|\r/g, "\n");
  if (!source.trim()) return "";
  return buildMarked(options).parse(source);
}

/**
 * Bộ render tăng dần cho message ĐANG STREAM.
 *
 * Chat flush theo `requestAnimationFrame`, nên parse lại cả message mỗi frame
 * là O(n²) với n là độ dài message. Ở đây chỉ render lại các block ở đuôi —
 * block trước đó giữ nguyên HTML đã cache, đúng tinh thần
 * `createStreamingMarkdownRenderer` của desktop.
 *
 * Giữ 2 block cuối vì một block đang lớn dần có thể đổi hình dạng block liền
 * trước (dòng `---` của bảng chỉ thành bảng khi đủ dòng dữ liệu sau nó).
 */
export function createMarkdownStream(options) {
  const marked = buildMarked(options);
  const RELEX_TAIL = 2;
  let tokens = [];
  let html = [];

  const renderOne = (token) => marked.parser([token]);

  return {
    render(text) {
      const source = String(text ?? "").replace(/\r\n|\r/g, "\n");
      if (!source.trim()) {
        tokens = [];
        html = [];
        return "";
      }
      const next = marked.lexer(source);
      const keep = Math.max(0, tokens.length - RELEX_TAIL);
      html = next.map((token, index) => {
        const priorToken = tokens[index];
        const priorHtml = html[index];
        return index < keep && priorToken && priorHtml !== undefined && priorToken.raw === token.raw
          ? priorHtml
          : renderOne(token);
      });
      tokens = next;
      return html.join("");
    },
    reset() {
      tokens = [];
      html = [];
    },
  };
}