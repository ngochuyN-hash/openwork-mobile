// Hai helper HTTP dùng ở mọi route: đọc body JSON có trần, và trả JSON.
// Trước đây mỗi route tự `res.writeHead(...); res.end(JSON.stringify(...))` —
// lặp lại ~25 lần trong index.js và là chỗ dễ quên header
// "content-type: application/json".

export async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}