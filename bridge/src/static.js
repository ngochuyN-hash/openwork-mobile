import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

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

export function createStaticHandler(webRoot) {
  const root = resolve(webRoot);

  return function handleStatic(req, res, pathname) {
    if (!existsSync(root)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("web/dist not built yet - run: cd web && npm install && npm run build");
      return;
    }

    let filePath = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    if (!filePath.startsWith(root)) {
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
    res.writeHead(200, {
      "content-type": type,
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    });
    createReadStream(filePath).pipe(res);
  };
}
