import { timingSafeEqual } from "node:crypto";

// Auth for the bridge's own API. The phone presents the mobile token
// (owm_...) that lives in the bridge config; we never expose the OpenWork
// owner token to the browser.

export function isAuthorized(req, mobileToken) {
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  const presented = match?.[1]?.trim();
  if (!presented || !mobileToken) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(mobileToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deny(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "unauthorized", message: "Invalid bridge token" }));
}

/** So sánh token đã trích (header hoặc ?_t=) với master token. */
export function isTokenAuthorized(presented, mobileToken) {
  if (!presented || !mobileToken) return false;
  return sameToken(presented, mobileToken);
}

function sameToken(presented, expected) {
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lấy Bearer token từ header, hoặc ?_t= (chỉ GET - cho EventSource/img). */
export function requestToken(req, url) {
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  if (match?.[1]) return match[1].trim();
  if (req.method.toUpperCase() === "GET") {
    const query = url.searchParams.get("_t");
    if (query) return query;
  }
  return "";
}
