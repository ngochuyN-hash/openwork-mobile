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

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const headers = {
    authorization: `Bearer ${ownerToken}`,
    "x-openwork-client-id": "openwork-mobile",
    accept: req.headers["accept"] ?? "*/*",
  };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  let body = undefined;
  if (hasBody) {
    body = Readable.toWeb(req);
    headers["content-type"] ||= "application/json";
  }

  let response;
  try {
    response = await fetch(upstream, {
      method: req.method.toUpperCase(),
      headers,
      body,
      duplex: body ? "half" : undefined,
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
    Readable.fromWeb(response.body).pipe(res);
    return;
  }

  res.writeHead(response.status, outHeaders);
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}
