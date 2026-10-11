/**
 * Vòng đời tải 1 file về máy — tách khỏi FileViewer (pages/files.jsx) để
 * `node --test` chạy được không cần DOM.
 *
 * Vì sao là một module riêng: đây là object sâu và tinh vi nhất của web nhưng
 * từng nhốt trong JSX với 0 test — comment bản cũ ghi lại HAI leak thật (URL
 * blob của lượt tải xong không revoke lúc unmount → iOS Safari giết tab; URL
 * tạo CHỈ để share không ai thu hồi → rò mỗi lần Chia sẻ file lớn) và MỘT bug
 * "hủy chết" (finally của lượt cũ xoá nhầm controller MỚI, nút Huỷ kế tiếp
 * không còn tác dụng và % chết đứng). Bốn mối — controller abort, token chống
 * race, revoke URL, cleanup lúc unmount — thuộc về MỘT chủ.
 *
 * Token chống race: `cancel()` huỷ controller NGAY, nên người dùng bấm "Tải
 * lại" được trong khoảnh vài ms trong khi promise cũ còn đang unwind; mọi
 * callback của lượt cũ (progress, xong, lỗi) phải vô hiệu — so token của từng
 * lượt, không so thời điểm.
 *
 * Module này không đụng DOM: xong lượt tải nó gọi `onSaved`, việc bấm
 * `<a download>` (cần document) là của caller.
 *
 * @param {object} deps
 * @param {({signal?: AbortSignal, onProgress?: (p: {loaded: number, total: number}) => void}) => Promise<{blob: Blob, filename: string}>} deps.download
 * @param {(state: null | {loaded: number, total: number} | {done: true, filename: string, url: string, blob: Blob}) => void} [deps.onChange]
 * @param {(error: Error) => void} [deps.onError] — lỗi KHÔNG phải AbortError (abort là hủy chủ đích, im lặng)
 * @param {({filename: string, url: string}) => void} [deps.onSaved]
 */
export function createDownloadTask({ download, onChange, onError, onSaved }) {
  let controller = null; // AbortController của lượt ĐANG chạy; null = rảnh
  let token = null; // Symbol của lượt đang chạy — chìa duy nhất cho callback của nó
  let current = null; // state công khai (giống cái phát qua onChange)
  const shareUrls = new Set(); // URL tạo CHỈ cho share — tự thu hồi lúc dispose

  const emit = (next) => {
    current = next;
    onChange?.(next);
  };

  return {
    /** Đang có lượt tải chạy? Nút Tải/Chia sẻ dùng để chặn bấm kép. */
    busy() {
      return controller !== null;
    },

    /** State hiện tại, cùng hình dạng với cái đã phát qua onChange. */
    current() {
      return current;
    },

    /** Bắt đầu tải. Đang chạy thì no-op (đúng bản cũ: `if (abortRef) return`).
     * Lượt mới revoke URL của lượt done TRƯỚC — emit({loaded:0}) đè trạng thái
     * done cũ, không revoke ở đây thì URL cũ leak cho tới dispose. */
    start() {
      if (controller) return;
      if (current?.url) URL.revokeObjectURL(current.url);
      const c = new AbortController();
      controller = c;
      const myToken = Symbol("download");
      token = myToken;
      emit({ loaded: 0, total: 0 });
      (async () => {
        try {
          const { blob, filename } = await download({
            signal: c.signal,
            onProgress: ({ loaded, total }) => {
              if (token === myToken) emit({ loaded, total });
            },
          });
          if (token !== myToken) return; // đã huỷ giữa đường — lượt cũ vô hiệu
          const url = URL.createObjectURL(blob);
          emit({ done: true, filename, url, blob });
          onSaved?.({ filename, url });
        } catch (e) {
          if (token !== myToken) return;
          if (e?.name !== "AbortError") onError?.(e);
          emit(null);
        } finally {
          // CHỈ lượt còn hợp lệ mới được mở khoá — finally của lượt cũ từng
          // xoá nhầm controller MỚI (bug "hủy chết" của bản JSX).
          if (token === myToken) {
            controller = null;
            token = null;
          }
        }
      })();
    },

    /** Huỷ lượt đang chạy: token chết NGAY (mọi callback lượt cũ vô hiệu),
     * abort controller, dọn state. Không có lượt nào thì no-op. */
    cancel() {
      token = null;
      controller?.abort();
      controller = null;
      emit(null);
    },

    /**
     * Blob sẵn sàng để chia sẻ. Dùng lại lượt done nếu có (hai luồng đọc cùng
     * một đường dẫn là lãng phí, và nút Huỷ chỉ nắm được luồng của `start()`);
     * chưa có thì tải mới KHÔNG signal (không nút huỷ nào nắm được luồng này —
     * đúng bản cũ). URL trả về: `url` thuộc lượt done (task tự revoke lúc
     * start/dispose), `ownedUrl` là URL tạo riêng cho lần share này — task tự
     * thu hồi lúc dispose, caller không phải lo (bản cũ tạo xong bỏ rơi: rò).
     */
    async getForShare() {
      if (current?.done) {
        return { blob: current.blob, filename: current.filename, url: current.url };
      }
      const { blob, filename } = await download({});
      const ownedUrl = URL.createObjectURL(blob);
      shareUrls.add(ownedUrl);
      return { blob, filename, ownedUrl };
    },

    /** Nhả MỌI tài nguyên: huỷ lượt đang chạy, revoke URL done + mọi URL share.
     * Gọi lúc unmount — bỏ nhịp này là mỗi file lớn mở ra giữ blob trong RAM. */
    dispose() {
      token = null;
      controller?.abort();
      controller = null;
      if (current?.url) URL.revokeObjectURL(current.url);
      current = null;
      for (const u of shareUrls) URL.revokeObjectURL(u);
      shareUrls.clear();
    },
  };
}
