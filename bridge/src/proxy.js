import { Readable } from "node:stream";

// Thin whitelist reverse proxy: phone -> bridge -> openwork-server.
// Injects the OpenWork owner bearer token so the browser never sees it.

const ALLOWED = [
  /^\/workspaces(\/|$)/,
  // session-groups đã bị gỡ khỏi whitelist 05/10: web phone không còn dùng
  // tính năng nhóm phiên (commit 97cd3ae) — engine vẫn có endpoint này, bridge
  // chỉ ngừng chuyển tiếp nó cho điện thoại.
  /^\/workspace\/[^/]+\/(events(\/|$)|files(\/|$)|opencode(\/|$)|engine\/reload|artifacts(\/|$)|inbox(\/|$))/,
  /^\/approvals(\/|$)/,
  /^\/files\/sessions\//,
  /^\/experimental\/(ui-control|extensions(\/|$))/,
  /^\/(status|capabilities|whoami|health)$/,
];

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const COPY_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
];

export function isProxyPathAllowed(path) {
  return ALLOWED.some((re) => re.test(path));
}

export function isMethodAllowed(method) {
  return ALLOWED_METHODS.has(method.toUpperCase());
}

// Engine (apps/server/src/routes/files.ts) luôn gắn Content-Disposition: inline
// cho /files/raw — đúng cho desktop (mở viewer trong app) nhưng trên điện thoại
// .docx/.xlsx sẽ mở ra một trang trắng vì trình duyệt không biết render gì.
// Ép "attachment" cho đúng nhóm file không có viewer nào, và chỉ nhóm đó: ảnh
// và PDF vẫn cần "inline" vì web hiển thị bằng <img>/<iframe>.
const FORCE_DOWNLOAD_EXT = new Set([
  // Office
  "doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "odt", "ods", "odp", "rtf", "epub",
  // Nén / gói cài đặt
  "zip", "7z", "rar", "gz", "tar", "bz2", "xz", "zst", "iso", "dmg", "apk", "msi", "exe", "jar", "war",
  // Nhị phân không ai mở được trong web (media mp4/mp3/wav thì trình duyệt
  // tự phát được nên để "inline")
  "bin", "dat", "db", "sqlite", "sqlite3", "pb", "pyc", "so", "dll", "lib", "o", "a", "class", "wasm",
  "psd", "sketch", "fig", "xd", "ai", "indd", "dwg", "dxf", "stl", "obj", "blend",
]);

/** true khi tên file thuộc nhóm browser không render được inline. */
export function shouldForceDownload(name) {
  const clean = String(name ?? "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return false;
  return FORCE_DOWNLOAD_EXT.has(clean.slice(dot + 1).toLowerCase());
}

/** Path đã bỏ query + dot-segment — để regex so đường dẫn, không dính "?path=". */
function rawPathOf(upstreamPath) {
  const [path] = String(upstreamPath ?? "").split("?");
  return normalizeDotSegments(path);
}

/** Lấy tên file từ ?path= để gắn content-disposition fallback. */
export function filenameFromQuery(rawUrl) {
  try {
    const query = String(rawUrl ?? "").split("?")[1] ?? "";
    const path = new URLSearchParams(query).get("path") ?? "";
    const clean = path.replace(/[\\/]+$/, "");
    const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return clean.slice(cut + 1);
  } catch {
    return "";
  }
}

// Resolve "." and ".." segments textually so the whitelist always judges the
// path the upstream URL will actually use (URL() normalizes dot segments).
export function normalizeDotSegments(path) {
  const out = [];
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * Forward one request to openwork-server and stream the answer back.
 * SSE responses stream through untouched (with a comment keepalive so idle
 * proxies do not close the connection).
 */
export async function proxyToOpenWork(req, res, upstreamPath, { baseUrl, ownerToken }) {
  if (!isMethodAllowed(req.method)) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "method_not_allowed", message: `Method ${req.method} not allowed` }));
    return;
  }
  if (!isProxyPathAllowed(normalizeDotSegments(upstreamPath))) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "forbidden", message: `Path not allowed through bridge: ${upstreamPath}` }));
    return;
  }

  const upstream = new URL(normalizeDotSegments(upstreamPath), baseUrl);
  const query = req.url?.split("?")[1];
  if (query) upstream.search = `?${query}`;

  // SSRF guard: proxy này CHỈ được nói chuyện với openwork-server cục bộ.
  // baseUrl đến từ discovery trên chính máy này, nhưng khoá cứng protocol +
  // hostname loopback để fetch không bao giờ trỏ ra ngoài kể cả khi discovery
  // / engine registry trả thứ gì lạ.
  if (upstream.protocol !== "http:" || !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(upstream.hostname)) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "upstream_unsafe", message: "openwork-server must be local (loopback http)." }));
    return;
  }

  const controller = new AbortController();
  // CHỈ abort khi client thật sự ngắt kết nối. Lưu ý: trong Node 18+,
  // req 'close' phát cả khi request kết thúc bình thường - dùng res + guard.
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const headers = {
    authorization: `Bearer ${ownerToken}`,
    "x-openwork-client-id": "openwork-mobile",
    accept: req.headers["accept"] ?? "*/*",
  };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  let body = undefined;
  if (hasBody) {
    // Buffer request body thay vì stream: openwork-server treo với chunked
    // encoding, và body mobile gửi (prompt/upload) đều nhỏ. Cap 64MB chống lạm dụng.
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "payload_too_large", message: "Body over 64MB" }));
        return;
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
    if (body.length > 0) headers["content-type"] ||= "application/json";
    else body = undefined;
  }

  let response;
  try {
    response = await fetch(upstream, {
      method: req.method.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (controller.signal.aborted) return; // client went away
    res.writeHead(502, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: "upstream_unavailable",
        message: "openwork-server unreachable (is OpenWork running?)",
      })
    );
    return;
  }

  const outHeaders = {};
  for (const name of COPY_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) outHeaders[name] = value;
  }

  // Chỉ nhìn PATH, không nhìn query: mọi request file thật đều mang ?path=
  // nên regex trên chuỗi đầy đủ sẽ không khớp ("raw?path=" ≠ "raw" cuối chuỗi).
  const isRawFileGet =
    req.method.toUpperCase() === "GET" && /^\/workspace\/[^/]+\/files\/raw(\/|$)/.test(rawPathOf(upstreamPath));

  // files/raw không phải SSE: nếu upstream quên gắn tên file, bridge tự gắn
  // "attachment" để điện thoại hiểu là lưu về máy (kể cả tên có dấu/cách).
  if (isRawFileGet && !outHeaders["content-disposition"]) {
    const name = filenameFromQuery(req.url);
    if (name) outHeaders["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  // ...và nếu upstream gắn "inline" cho file web không render được (docx/xlsx…),
  // vẫn phải đổi thành "attachment" — nếu không điện thoại mở ra trang trắng.
  if (isRawFileGet) {
    const name = filenameFromQuery(req.url);
    if (name && shouldForceDownload(name)) {
      outHeaders["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
  }

  const isSSE = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isSSE) {
    outHeaders["cache-control"] = "no-cache";
    req.socket.setNoDelay(true);
    res.writeHead(response.status, outHeaders);
    res.flushHeaders();
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(":keepalive\n\n");
    }, 20_000);
    res.on("close", () => clearInterval(keepalive));
    Readable.fromWeb(response.body)
      .on("error", () => res.end())
      .pipe(res);
    return;
  }

  res.writeHead(response.status, outHeaders);
  if (response.body) {
    Readable.fromWeb(response.body)
      .on("error", () => res.end())
      .pipe(res);
  } else res.end();
}
