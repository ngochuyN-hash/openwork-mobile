// Liệt kê thư mục trên máy để điện thoại "duyệt" thay vì gõ tay đường dẫn
// khi tạo workspace. CHỈ trả thư mục (không file) để hạn chế lộ thông tin máy.
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, normalize } from "node:path";

// Nền rác hệ thống ở gốc ổ đĩa, ai cũng có nhưng không bao giờ là project.
const NOISE = new Set(["$recycle.bin", "system volume information", "config.msi"]);

/** Ổ đĩa Windows bằng cách thử A:\..Z:\ (không cần lệnh ngoài). */
async function windowsDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = `${String.fromCharCode(i)}:\\`;
    try {
      await fs.access(letter);
      drives.push({ name: letter, path: letter });
    } catch {
      // không có ổ này
    }
  }
  return drives;
}

/**
 * Điểm xuất phát cho trình duyệt thư mục: ổ đĩa + vài đường hay dùng.
 * Mục nào không tồn tại (ví dụ máy không có Desktop) thì bỏ qua.
 */
export async function listRoots() {
  const isWindows = platform() === "win32";
  const roots = isWindows ? await windowsDrives() : [{ name: "/", path: "/" }];

  const home = homedir();
  // Label = tên folder thật trên máy (vd "user"), không dịch ra tiếng Việt —
  // user muốn thấy y chang những gì có trong File Explorer.
  const quick = [{ label: home.split(/[\\/]+/).filter(Boolean).pop() ?? home, path: home }];
  for (const sub of ["Desktop", "Documents", "Downloads"]) {
    const dir = join(home, sub);
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) quick.push({ label: sub, path: dir });
    } catch {
      // không có thì khỏi gợi ý
    }
  }
  return { isWindows, home, roots, quick };
}

/**
 * Danh sách thư mục con của `dir` (đã lọc ẩn + rác hệ thống, sắp A→Z).
 * Trả đủ path chuẩn để điền thẳng vào form tạo workspace.
 */
export async function listDirs(dir) {
  const clean = normalize(String(dir ?? "").trim());
  if (!clean) throw fsError("ENOENT", "Chưa chọn đường dẫn.");

  let entries;
  try {
    entries = await fs.readdir(clean, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw fsError("ENOENT", "Thư mục không tồn tại (có thể đã bị xóa hoặc đổi tên).");
    }
    if (error?.code === "ENOTDIR") {
      throw fsError("ENOTDIR", "Đây là file, không phải thư mục.");
    }
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw fsError("EACCES", "Không có quyền xem thư mục này.");
    }
    throw error;
  }

  const dirs = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || NOISE.has(name.toLowerCase())) continue;
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      // junction/symlink (thường gặp với thư mục project) — soi đích xem có phải thư mục không
      try {
        isDir = (await fs.stat(join(clean, name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) dirs.push({ name, path: join(clean, name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "vi", { sensitivity: "base", numeric: true }));

  const parent = normalize(dirname(clean));
  return {
    path: clean,
    parent: parent === clean ? null : parent, // đang ở gốc ổ đĩa thì hết đường lên
    name: clean.split(/[\\/]+/).filter(Boolean).pop() ?? clean,
    dirs,
  };
}

function fsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
