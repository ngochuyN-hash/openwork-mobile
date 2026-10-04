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

const TEXT_ESCAPE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const TEXT_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * Escape nhưng GIỮ NGUYÊN entity hợp lệ, giống hàm `escape` nội bộ của marked.
 *
 * `escapeHtml` escape thẳng `&`, nên `AT&amp;T` (cách agent hay viết tên công ty,
 * hay cả `R&amp;D`, `Q&A`) ra `AT&amp;amp;T` — người đọc thấy chữ `&amp;`.
 * Chỉ dùng cho TEXT; `code`/`codespan` phải escape thẳng vì GFM coi entity
 * trong code là chữ nghĩa đ literally.
 */
function escapeText(value) {
  const source = String(value);
  return TEXT_ESCAPE_RE.test(source) ? source.replace(TEXT_ESCAPE_RE, (ch) => TEXT_ESCAPE_MAP[ch]) : source;
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
  // (?<![A-Za-z0-9]) chặn `s:/` trong `https://` khớp nhầm thành đường dẫn
  // Windows — không có nó, mọi URL trần trong tin agent đều sinh <a> lồng <a>.
  const windows = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'“”'()[\]<>]{1,180}/g;
  const relative = /(^|[\s"'“”'(\[])([\w\-.]+(?:[\\/][\w\-.]+)+\.\w{2,5})\b/g;
  out = out.replace(windows, (m) => wrapPath(m, m, fileHref));
  out = out.replace(relative, (m, lead, path) => `${lead}${wrapPath(path, path, fileHref)}`);
  return out;
}

/** Bỏ tiền tố `./` để `fileHref` không nhận path không chuẩn. */
function normalizeFilePath(path) {
  return String(path).replace(/^\.\//, "");
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
    // Token lạ không có renderer thì trả "" thay vì throw ra giữa render.
    silent: true,
    renderer: {
      html(token) {
        return escapeText(token.text);
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
        // marked v15 để checkbox ở `item.task`, KHÔNG nhét token `checkbox` vào
        // `item.tokens` — không tự chèn thì `- [ ]` mất sạch dấu tick.
        const box = item.task ? this.checkbox({ checked: !!item.checked }) : "";
        // `loose` quyết định có bọc <p> trong <li> không: list gọn thì để
        // chữ nằm thẳng trong ô, list rời (có dòng trống) thì mới tái đoạn.
        return `<li>${box}${this.parser.parse(item.tokens, item.loose)}</li>`;
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
        const path = typeof fileHref === "function" && FILE_HINT_EXT.test(text) ? normalizeFilePath(text) : null;
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
        // Nhãn phải đi qua `textRenderer`: nếu để `renderer.text` của ta chạy,
        // nó sẽ link-hóa đường dẫn NGAY TRONG nhãn và sinh <a> lồng <a>
        // (URL trần trong câu là ví dụ dễ gặp nhất).
        const label = this.parser.parseInline(tokens, this.parser.textRenderer);
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        if (!isExternalHref(href) && typeof fileHref === "function" && FILE_HINT_EXT.test(href)) {
          let local = "";
          try {
            local = fileHref(normalizeFilePath(href));
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
        // Ảnh trong workspace phải đi qua `fileHref` y hệt link/code span,
        // nếu không `![](screenshot.png)` sẽ ra ảnh vỡ vì safeHref("a.png")
        // không phải URL hợp lệ.
        let src = safeHref(href);
        if (typeof fileHref === "function" && !isExternalHref(href)) {
          try {
            src = fileHref(normalizeFilePath(href)) || src;
          } catch {
            /* giữ src đã an toàn */
          }
        }
        return `<a href="${escapeAttribute(src)}" target="_blank" rel="noreferrer"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(escapeText(text))}"${titleAttr} loading="lazy" decoding="async"></a>`;
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
        // Giữ `style` cho khớp desktop, nhưng thêm class để CSS không phụ
        // thuộc vào định dạng chuỗi `style=` — đổi renderer là rule CSS chết.
        const style = align ? ` style="text-align:${align}"` : "";
        const alignClass = align ? ` class="md-align-${align}"` : "";
        return `<${tag}${alignClass}${style}>${this.parser.parseInline(tokens)}</${tag}>`;
      },
      del({ raw, tokens }) {
        // marked v15 cho cả `~một~` thành <del>; desktop chặn lại vì `a ~ b ~ c`
        // hay bị hiểu nhầm là gạch ngang. Copy y nguyên guard của desktop.
        if (!raw.startsWith("~~")) return escapeHtml(raw);
        return `<del>${this.parser.parseInline(tokens, this.parser.textRenderer)}</del>`;
      },
      hr() {
        return `<hr>`;
      },
      text(token) {
        if (token.tokens) return this.parser.parseInline(token.tokens);
        return linkifyPaths(escapeText(token.text), fileHref);
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
 * Định nghĩa reference-style link: `[nhãn][r]` + dòng `[r]: đường-dẫn`.
 *
 * marked v15 NUỐT mất token `def` (v17 mới phát ra), nên không thể dò bằng
 * `tokens.some(t => t.type === "def")` như desktop. Dò thẳng ở mức source.
 */
const REFERENCE_DEF = /(^|\n)[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S/;

/**
 * Bộ render tăng dần cho message ĐANG STREAM.
 *
 * Chat flush theo `requestAnimationFrame`, nên parse lại cả message mỗi frame
 * là O(n²) với n là độ dài message. Ở đây chỉ lex/render lại phần đuôi mới —
 * block trước đó giữ nguyên HTML đã cache, đúng tinh thần
 * `createStreamingMarkdownRenderer` của desktop.
 *
 * Giữ 2 block cuối vì một block đang lớn dần có thể đổi hình dạng block liền
 * trước (dòng `---` của bảng chỉ thành bảng khi đủ dòng dữ liệu sau nó).
 */
export function createMarkdownStream(options) {
  const marked = buildMarked(options);
  const RELEX_TAIL = 2;
  let source = "";
  let tokens = [];
  let html = [];

  const renderOne = (token) => marked.parser([token]);

  /** Lex lại toàn bộ — dùng khi có reference def hoặc không còn là tiền tố. */
  const renderAll = (next, reuse) => {
    const previousTokens = tokens;
    const previousHtml = html;
    const keep = reuse ? Math.max(0, previousTokens.length - RELEX_TAIL) : 0;
    html = next.map((token, index) => {
      const priorToken = previousTokens[index];
      const priorHtml = previousHtml[index];
      return index < keep && priorToken && priorHtml !== undefined && priorToken.raw === token.raw
        ? priorHtml
        : renderOne(token);
    });
    tokens = next;
  };

  /**
   * Chỉ lex phần đuôi mới: bỏ `keep` block đầu (đã chốt), cắt source tại ranh
   * giới chúng rồi lex phần còn lại. Đây là chỗ giảm O(n²) — lexer chiếm
   * ~90% thời gian render, nên chỉ cache HTML là chưa đủ.
   *
   * Trả `false` khi không dùng được (quá ít block) để quay về `renderAll`.
   */
  const renderAppended = (nextSource) => {
    const keep = tokens.length - RELEX_TAIL;
    if (keep <= 0) return false;
    let offset = 0;
    for (const token of tokens.slice(0, keep)) offset += token.raw.length;
    const tail = marked.lexer(nextSource.slice(offset));
    html = [...html.slice(0, keep), ...tail.map(renderOne)];
    tokens = [...tokens.slice(0, keep), ...tail];
    return true;
  };

  return {
    render(text) {
      const nextSource = String(text ?? "").replace(/\r\n|\r/g, "\n");
      if (!nextSource.trim()) {
        source = "";
        tokens = [];
        html = [];
        return "";
      }
      // Reference def giải thích link XUYÊN block, nên khi có mặt phải bỏ
      // toàn bộ HTML đã cache: block đầu được render lúc CHƯA có định nghĩa
      // thì ra text thuần, mà `raw` của nó không đổi nên nếu tái dùng thì link
      // không bao giờ hiện — kể cả khi message đã stream xong.
      const hasDef = REFERENCE_DEF.test(nextSource) || REFERENCE_DEF.test(source);
      const appended = !hasDef && nextSource.startsWith(source) && renderAppended(nextSource);
      if (!appended) renderAll(marked.lexer(nextSource), !hasDef);
      source = nextSource;
      return html.join("");
    },
    reset() {
      source = "";
      tokens = [];
      html = [];
    },
  };
}