// Blob URL cho <img>/<iframe> (không dán token lên URL) — tách khỏi api.js
// (round 4, 09/10): đây là kho cache preview, không phải transport; nó DÙNG
// ow() của api.js theo một chiều (api.js không cần gì từ file này nên không
// có vòng import).
//
// `<img src>` và `<iframe src>` không set được header Authorization. Bản cũ dán
// token vào query `?_t=` cho chúng — token đó lọt vào history trình duyệt, vào
// Referer của mọi request sau, và vào log của worker/cloudflared/bridge. Nay mọi
// request đi bằng header; riêng hai thẻ kia thì fetch bằng header rồi gắn
// `blob:`. `sseUrl()` (dán `?_t=`) đã bỏ hẳn.
import { blobCacheKey, createBlobCache, parseBlobCacheKey } from "./blob-cache.js";
import { ow } from "../api.js";

const blobCache = createBlobCache({
  create: async (key) => {
    const { wsId, path } = parseBlobCacheKey(key);
    const res = await ow(`/workspace/${encodeURIComponent(wsId)}/files/raw?path=${encodeURIComponent(path)}`, {
      raw: true,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.message ?? "";
      } catch {
        /* body không phải JSON — giữ HTTP status */
      }
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), bytes: blob.size };
  },
  revoke: (url) => URL.revokeObjectURL(url),
});

/**
 * Object URL để xem trước 1 file (ảnh, PDF). Auth đi qua header nên token không
 * bao giờ lên URL. Cache LRU theo byte nên mở lại file vừa xem là tức thì.
 */
export function blobUrlFor(wsId, path) {
  if (!wsId || !path) return Promise.resolve("");
  return blobCache.load(blobCacheKey(wsId, path));
}

/** Xoá cache blob (gỡ pairing: bytes của máy cũ không còn ý nghĩa). */
export function clearBlobUrls() {
  blobCache.clear();
}
