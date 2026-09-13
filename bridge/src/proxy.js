import { Readable } from "node:stream";

// Thin whitelist reverse proxy: phone -> bridge -> openwork-server.
// Injects the OpenWork owner bearer token so the browser never sees it.

const ALLOWED = [
  /^\/workspaces(\/|$)/,
  /^\/workspace\/[^/]+\/(events(\/|$)|session-groups|files(\/|$)|opencode(\/|$)|engine\/reload|artifacts(\/|$)|inbox(\/|$))/,
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

  // files/raw không phải SSE: nếu upstream quên gắn tên file, bridge tự gắn
  // "attachment" để điện thoại hiểu là lưu về máy (kể cả tên có dấu/cách).
  if (
    req.method.toUpperCase() === "GET" &&
    !outHeaders["content-disposition"] &&
    /^\/workspace\/[^/]+\/files\/raw(\/|$)/.test(normalizeDotSegments(upstreamPath))
  ) {
    const name = filenameFromQuery(req.url);
    if (name) outHeaders["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
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
