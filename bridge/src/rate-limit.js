// Rate limit theo IP cho các route nhạy cảm: /api/pair (dò mã ghép) và
// /api/openwork/* (bấm liên tục). Cửa sổ trượt 60s, đếm theo IP.
//
// Tách riêng khỏi index.js vì đây là logic thuần không cần HTTP: test được
// bằng cách đổi đồng hồ, không cần dựng server thật.
export function createRateLimiter({ limit, windowMs = 60_000 }) {
  const attempts = new Map();
  return {
    limited(ip) {
      const now = Date.now();
      const list = (attempts.get(ip) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= limit) {
        attempts.set(ip, list);
        return true;
      }
      list.push(now);
      attempts.set(ip, list);
      return false;
    },
    sweep() {
      const now = Date.now();
      for (const [ip, list] of attempts) {
        const alive = list.filter((t) => now - t < windowMs);
        if (alive.length) attempts.set(ip, alive);
        else attempts.delete(ip);
      }
    },
  };
}

/**
 * Sweep stale IPs ra khỏi các map rate-limit: entry quá hạn chỉ là rác — không
 * dọn thì cả hai map phình vô hạn theo mọi IP từng thấy (bridge chạy dài hạn).
 */
export function startRateLimitSweep(limiters, intervalMs = 5 * 60_000) {
  return setInterval(() => {
    for (const limiter of limiters) limiter.sweep();
  }, intervalMs).unref();
}