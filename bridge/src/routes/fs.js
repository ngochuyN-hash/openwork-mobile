import { readJsonBody, sendJson } from "../http-util.js";
import { listDirs, listRoots, makeDir } from "../fslist.js";

// Bản đồ lỗi fs → HTTP status — MỘT chỗ cho ls + mkdir, route test ghim từng
// hàng (bridge/test/fs-routes.test.js). Trước 07/10 mọi lỗi không lọt bảng
// biến thành 403: lỗi nội bộ (EIO…) presenting as "no permission" lừa cả
// người debug lẫn client. fallback chỉ dùng cho lỗi KHÔNG lường trước (500).
export function fsStatus(error, fallback) {
  switch (error?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return 404;
    case "EEXIST":
    case "EINVAL":
      return 400;
    case "EACCES":
    case "EPERM":
      return 403;
    default:
      return fallback;
  }
}

// Nhóm "duyệt thư mục máy tính" để tạo workspace khỏi gõ tay đường dẫn.
// Nằm sau khóa thiết bị như các API khác.
export function createFsRoutes() {
  async function ls({ res, url }) {
    const target = url.searchParams.get("path")?.trim();
    try {
      const result = target ? await listDirs(target) : { ...(await listRoots()), ok: true };
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, fsStatus(error, 500), {
        code: error?.code ?? "fs_error",
        message: String(error?.message ?? error),
      });
    }
  }

  // Tạo thư mục mới con cho nút "+ Thư mục mới" trong picker.
  async function mkdir({ req, res }) {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, await makeDir(body?.dir, body?.name));
    } catch (error) {
      sendJson(res, fsStatus(error, 500), {
        code: error?.code ?? "fs_error",
        message: String(error?.message ?? error),
      });
    }
  }

  return [
    { method: "GET", match: "/api/fs/ls", handle: ls },
    { method: "POST", match: "/api/fs/mkdir", handle: mkdir },
  ];
}
