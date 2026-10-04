// Cache object URL cho file workspace — LRU theo DUNG LƯỢNG + chống tải trùng.
//
// VÌ SAO CẦN: `<img src>`/`<iframe src>` không set được header Authorization,
// nên bản cũ dán token vào query `?_t=` để mở được ảnh/PDF. Token vậy lộ ra
// history trình duyệt, Referer gửi đi cùng mọi request, và log của mọi proxy
// trung gian. Cách đúng là fetch bằng header (token không rời JS) rồi gắn
// `blob:` — và cache lại để không tải lại.
//
// Tách khỏi api.js + DOM để `node --test` chạy được: `create`/`revoke` được
// tiêm vào, không đụng `URL.createObjectURL` thật.

/** Trần dung lượng blob bytes được giữ lại. Blob URL giữ bytes trong RAM cho
 *  tới khi bị thu hồi, nên đây là hồi bộ nhớ của điện thoại chứ không phải
 *  cache cho nhanh. 64 MB đủ cho hàng chục ảnh trong một phiên chat. */
export const BLOB_CACHE_BYTES = 64 * 1024 * 1024;

/** Trần số mục — chỉ để cache không phình vô hạn khi file to (một entry PDF
 *  40 MB có thể đã dính trần byte rồi). */
export const BLOB_CACHE_ENTRIES = 64;

const DEFAULT_OPTIONS = { bytes: BLOB_CACHE_BYTES, entries: BLOB_CACHE_ENTRIES };

/**
 * `make(key)` trả về URL (string) hoặc `{url, bytes}` — bytes chỉ để quyết
 * định đuổi ai, không bắt buộc.
 *
 * @param {object} options
 * @param {(key: string) => Promise<string|{url: string, bytes?: number}>} options.create
 * @param {(url: string) => void} [options.revoke]
 * @param {number} [options.bytes] trần tổng bytes
 * @param {number} [options.entries] trần số mục
 */
export function createBlobCache({ create, revoke, ...limits } = {}) {
  // Bỏ `undefined`: caller truyền `{entries: n}` sẽ kéo theo `bytes: undefined`,
  // và spread của object literal ghi đè default bằng `undefined` — mọi so sánh
  // `<= undefined` thành false nên cache đuổi sạch mọi mục vừa thêm.
  const merged = { ...DEFAULT_OPTIONS };
  for (const [k, v] of Object.entries(limits)) if (v !== undefined) merged[k] = v;
  const maxBytes = merged.bytes;
  const maxEntries = merged.entries;
  const urls = new Map(); // key -> {url, bytes}; thứ tự = cũ -> mới
  const inflight = new Map(); // key -> Promise<url>
  let totalBytes = 0;

  function totalEntries() {
    return urls.size;
  }

  function evictTo(keepKey) {
    // Đuổi từ cũ tới mới cho tới khi vừa trần. Giữ lại `keepKey` (mục vừa
    // thêm) dù nó nặng: nó là thứ vừa mở, đuổi nó là mất ảnh đang xem.
    for (const [key, entry] of urls) {
      if (key === keepKey) continue;
      if (totalEntries() <= maxEntries && totalBytes <= maxBytes) return;
      urls.delete(key);
      totalBytes -= entry.bytes || 0;
      revoke?.(entry.url);
    }
    // Còn mỗi `keepKey` và nó vẫt trần: vẫn giữ. Cache phải phục vụ người
    // đang xem, không phải giữ chỗ.
  }

  return {
    get size() {
      return urls.size;
    },
    get bytes() {
      return totalBytes;
    },
    has(key) {
      return urls.has(key);
    },
    /** URL đã cache, hoặc "" — không tải. */
    peek(key) {
      return urls.get(key)?.url ?? "";
    },
    /**
     * URL cho `key`, tải bằng `create` nếu chưa có. Lượt đang bay được CHIA SẺ:
     * hai chỗ cùng xem một file trong cùng nhịp vẽ chỉ tải MỘT lần (không
     * phải hai, và URL tải ra nhưng bị đuổi sẽ không còn dùng để gắn vào node
     * đã chết).
     */
    load(key) {
      const hit = urls.get(key);
      if (hit) {
        // Chạm lại để nó thành mới nhất (đọc cũng tính là dùng).
        urls.delete(key);
        urls.set(key, hit);
        return Promise.resolve(hit.url);
      }
      const pending = inflight.get(key);
      if (pending) return pending;
      const task = Promise.resolve()
        .then(() => create(key))
        .then((made) => {
          const url = typeof made === "string" ? made : String(made?.url ?? "");
          if (!url) throw new Error("blob rỗng");
          const fresh = urls.get(key);
          if (fresh) return fresh.url; // lượt khác kịp đưa vào trước
          const size = typeof made === "string" ? 0 : Number(made?.bytes ?? 0) || 0;
          urls.set(key, { url, bytes: size });
          totalBytes += size;
          evictTo(key);
          return url;
        })
        .finally(() => {
          if (inflight.get(key) === task) inflight.delete(key);
        });
      inflight.set(key, task);
      return task;
    },
    /** Bỏ đúng một key (file không còn ai xem). Trả true nếu có thật. */
    drop(key) {
      const entry = urls.get(key);
      if (!entry) return false;
      urls.delete(key);
      totalBytes -= entry.bytes || 0;
      revoke?.(entry.url);
      return true;
    },
    clear() {
      for (const entry of urls.values()) revoke?.(entry.url);
      urls.clear();
      totalBytes = 0;
    },
  };
}

/** Khoá cache: cùng tên file ở workspace/máy khác phải là mục khác. */
export function blobCacheKey(wsId, path) {
  return `${String(wsId ?? "")}\u0000${String(path ?? "")}`;
}

/** Tách key cache về lại cặp (wsId, path) — tiện cho test và cho log. */
export function parseBlobCacheKey(key) {
  const at = String(key ?? "").indexOf("\u0000");
  if (at < 0) return { wsId: "", path: String(key ?? "") };
  return { wsId: key.slice(0, at), path: key.slice(at + 1) };
}