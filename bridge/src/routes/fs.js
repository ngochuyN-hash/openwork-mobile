import { readJsonBody, sendJson } from "../http-util.js";
import { listDirs, listRoots, makeDir } from "../fslist.js";

// Nhóm "duyệt thư mục máy tính" để tạo workspace khỏi gõ tay đường dẫn.
// Nằm sau khóa thiết bị như các API khác.
export function createFsRoutes() {
  async function ls({ res, url }) {
    const target = url.searchParams.get("path")?.trim();
    try {
      const result = target ? await listDirs(target) : { ...(await listRoots()), ok: true };
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error?.code === "ENOENT" || error?.code === "ENOTDIR" ? 404 : 403, {
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
      sendJson(res, error?.code === "EEXIST" || error?.code === "EINVAL" ? 400 : 403, {
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