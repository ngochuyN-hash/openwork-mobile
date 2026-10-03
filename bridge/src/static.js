import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

// Minimal static file server for the built web app (web/dist), with SPA fallback.

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/**
 * Path guard for a route that needs NO token. A plain prefix check is not
 * enough: "C:\\web\\dist" IS a string prefix of "C:\\web\\dist-old", and a
 * decoded "%2e%2e%2f" inside the path walks out before join() resolves it.
 * path.relative judges the resolved path itself: anything climbing out
 * ("..") or landing on another drive (absolute) fails.
 */
export function isInsideRoot(root, target) {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function createStaticHandler(webRoot) {
  const root = resolve(webRoot);

  return function handleStatic(req, res, pathname) {
    if (!existsSync(root)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("web/dist not built yet - run: cd web && npm install && npm run build");
      return;
    }

    // Decode defensively: callers may hand over a still-encoded path, and
    // "%2e%2e%2f" must be judged AFTER decoding, never as literal text.
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad path encoding");
      return;
    }

    let filePath = normalize(join(root, decoded === "/" ? "index.html" : decoded));
    // filePath === root (empty path) is allowed — it falls through to the
    // SPA fallback below; anything OUTSIDE the root is rejected.
    if (filePath !== root && !isInsideRoot(root, filePath)) {
      res.writeHead(403);
      res.end();
      return;
    }

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      // SPA fallback: unknown paths serve the app shell.
      filePath = join(root, "index.html");
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const stream = createReadStream(filePath);
    // File vanished between stat() and open() (or unreadable): without this
    // handler the stream error escapes as an uncaughtException.
    stream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy(); // headers (maybe some bytes) already out — cut the socket
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "read_error", message: String(error?.message ?? error) }));
    });
    // 200 only goes out once the file is really open — a failed open must not
    // look like a 200 with a truncated body.
    stream.on("open", () => {
      res.writeHead(200, {
        "content-type": type,
        "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      });
      stream.pipe(res);
    });
  };
}
