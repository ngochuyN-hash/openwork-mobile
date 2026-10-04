import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListeningPorts, isOpenWorkServerHealth } from "../src/discovery.js";
import { isProxyPathAllowed, isMethodAllowed, normalizeDotSegments, filenameFromQuery, shouldForceDownload } from "../src/proxy.js";
import { isAuthorized, isTokenAuthorized, requestToken } from "../src/auth.js";
import { hashToken } from "../src/bootstrap.js";
import { candidateExePaths, findOpenWorkExe } from "../src/openwork-launch.js";
import { AUTOSTART_TASK_NAME, buildAutostartAction, bridgeEntryPath } from "../src/autostart.js";
import { listDirs, makeDir } from "../src/fslist.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { LOG_NAMES, deleteLogs, rotateStaleLogs, wipeLogs } from "../src/logwipe.js";

test("parseListeningPorts filters by pid and extracts ports", () => {
  const netstat = [
    "  TCP    127.0.0.1:62222    0.0.0.0:0    LISTENING    14316",
    "  TCP    127.0.0.1:49362    0.0.0.0:0    LISTENING    14316",
    "  TCP    127.0.0.1:49363    0.0.0.0:0    LISTENING    17020",
    "  TCP    0.0.0.0:443        0.0.0.0:0    LISTENING    4",
  ].join("\r\n");
  assert.deepEqual(parseListeningPorts(netstat, 14316).sort(), [49362, 62222]);
  assert.deepEqual(parseListeningPorts(netstat, 9999), []);
});

test("isOpenWorkServerHealth requires ok + opencodeVersion", () => {
  assert.equal(isOpenWorkServerHealth({ ok: true, opencodeVersion: "1.18.18" }), true);
  assert.equal(isOpenWorkServerHealth({ ok: true, app: "OpenWork", version: 2 }), false);
  assert.equal(isOpenWorkServerHealth(null), false);
});

test("proxy whitelist allows management paths, blocks everything else", () => {
  const allow = [
    "/workspaces",
    "/workspaces/local",
    "/workspace/ws_1/session-groups",
    "/workspace/ws_1/opencode/session",
    "/workspace/ws_1/opencode/session/ses_1/message",
    "/workspace/ws_1/files/content",
    "/approvals",
    "/approvals/appr_1",
    "/files/sessions/ses_1/ops",
    "/experimental/ui-control/pending",
    "/status",
  ];
  for (const p of allow) assert.equal(isProxyPathAllowed(p), true, p);

  const deny = [
    "/tokens",
    "/env",
    "/dev/log",
    "/workspace/ws_1/secret",
    "/workspace/ws_1/opencode/../../hack",
    "/runtime/upgrade",
  ];
  for (const p of deny) assert.equal(isProxyPathAllowed(normalizeDotSegments(p)), false, p);
});

test("normalizeDotSegments resolves traversal before whitelist", () => {
  assert.equal(normalizeDotSegments("/workspace/ws_1/opencode/../../hack"), "/workspace/hack");
  assert.equal(normalizeDotSegments("/a/./b/../c/"), "/a/c");
});

test("method allowlist", () => {
  assert.equal(isMethodAllowed("GET"), true);
  assert.equal(isMethodAllowed("POST"), true);
  assert.equal(isMethodAllowed("PUT"), true);
  assert.equal(isMethodAllowed("DELETE"), true);
  assert.equal(isMethodAllowed("TRACE"), false);
});

test("bridge auth requires exact bearer token", () => {
  const token = "owm_abc";
  const req = (value) => ({ headers: { authorization: value } });
  assert.equal(isAuthorized(req(`Bearer ${token}`), token), true);
  assert.equal(isAuthorized(req(`Bearer ${token}x`), token), false);
  assert.equal(isAuthorized(req(undefined), token), false);
  assert.equal(isAuthorized(req("Basic abc"), token), false);
});

test("?_t= query token counts as master token (EventSource/img/a)", () => {
  const token = "owm_abc";
  const get = (t) => ({ method: "GET", headers: {} });
  const url = (t) => new URL(`http://x/api/ow/a?path=f${t ? `&_t=${t}` : ""}`);
  // trích được từ query...
  assert.equal(requestToken(get(), url(`Bearer ${token}`)), `Bearer ${token}`);
  assert.equal(requestToken(get(), url(token)), token);
  assert.equal(requestToken(get(), url("")), "");
  // ...và được công nhận như header (fix bug cũ: isAuthorized chỉ nhìn header)
  assert.equal(isTokenAuthorized(requestToken(get(), url(token)), token), true);
  assert.equal(isTokenAuthorized(requestToken(get(), url(`${token}x`)), token), false);
  assert.equal(isTokenAuthorized(requestToken(get(), url("")), token), false);
  // POST không được auth bằng query
  const post = { method: "POST", headers: {} };
  assert.equal(requestToken(post, url(token)), "");
});

test("hashToken matches OpenWork's sha256 scheme", () => {
  const token = "owt_deadbeef";
  assert.equal(hashToken(token), createHash("sha256").update(token).digest("hex"));
});

test("files/raw cho qua whitelist + bóc được tên file làm fallback download", () => {
  assert.equal(isProxyPathAllowed("/workspace/ws_1/files/raw"), true);
  assert.equal(filenameFromQuery("/api/ow/workspace/ws_1/files/raw?path=docs%2Fb%C3%A1o%20c%C3%A1o.pdf"), "báo cáo.pdf");
  assert.equal(filenameFromQuery("/api/ow/workspace/ws_1/files/raw?path=clip.mp4"), "clip.mp4");
  assert.equal(filenameFromQuery("/api/ow/workspace/ws_1/files/raw"), "");
});

test("chỉ ép attachment cho file web không render được, ảnh/PDF giữ inline", () => {
  assert.equal(shouldForceDownload("báo cáo.xlsx"), true);
  assert.equal(shouldForceDownload("hop-hop.XLSX"), true);
  assert.equal(shouldForceDownload("slide.pptx"), true);
  assert.equal(shouldForceDownload("data.sqlite"), true);
  assert.equal(shouldForceDownload("bundle.js"), false);
  assert.equal(shouldForceDownload("báo cáo.pdf"), false, "PDF vẫn xem trước bằng iframe");
  assert.equal(shouldForceDownload("ảnh.png"), false, "ảnh vẫn xem bằng <img>");
  assert.equal(shouldForceDownload("clip.mp4"), false, "media thì trình duyệt tự phát, để inline");
  assert.equal(shouldForceDownload("Dockerfile"), false, "không có đuôi thì không ép");
});

test("tìm OpenWork.exe: ưu tiên env -> config -> chỗ hay gặp", () => {
  const saved = process.env.OPENWORK_EXE;
  // Thứ tự ưu tiên là thuần logic, test được mọi máy
  process.env.OPENWORK_EXE = "C:\\uu-tien\\env.exe";
  assert.deepEqual(candidateExePaths("C:\\caut-hinh\\config.exe").slice(0, 2), [
    "C:\\uu-tien\\env.exe",
    "C:\\caut-hinh\\config.exe",
  ]);
  // findOpenWorkExe trả về file có thật (tạo file tạm để test)
  const tmp = join(tmpdir(), "ow-test-exe.exe");
  try {
    writeFileSync(tmp, "x");
    process.env.OPENWORK_EXE = tmp;
    assert.equal(findOpenWorkExe(""), tmp);
  } finally {
    try { rmSync(tmp); } catch {}
    if (saved === undefined) delete process.env.OPENWORK_EXE;
    else process.env.OPENWORK_EXE = saved;
  }
});

test("lệnh autostart schtasks bọc ngoặc kép kỹ đường dẫn có dấu cách", () => {
  assert.equal(AUTOSTART_TASK_NAME, "OpenPocketBridge");
  assert.match(bridgeEntryPath(), /index\.js$/);
  const action = buildAutostartAction();
  assert.match(action, /^".+" ".+index\.js"$/);
});

test("listDirs: chỉ trả thư mục, bỏ ẩn/rác hệ thống, sắp A→Z", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-fslist-"));
  try {
    for (const dir of ["Zeta", "alpha", "Project 2", "Project 10", ".git", "$RECYCLE.BIN", "System Volume Information"]) {
      mkdirSync(join(root, dir));
    }
    writeFileSync(join(root, "readme.md"), "x"); // file thì phải bị lọc
    const result = await listDirs(root);
    // .git, $RECYCLE.BIN, System Volume Information bị lọc; readme.md là file cũng bị lọc
    assert.deepEqual(result.dirs.map((d) => d.name), [
      "alpha",
      "Project 2",
      "Project 10",
      "Zeta",
    ]);
    assert.ok(result.dirs.every((d) => ![".git", "$RECYCLE.BIN", "readme.md"].includes(d.name)));
    assert.ok(result.parent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listDirs: lỗi rõ ràng khi thư mục không tồn tại", async () => {
  await assert.rejects(() => listDirs(join(tmpdir(), "ow-khong-ton-tai-xyz-123")), /không tồn tại/);
});

test("makeDir: tạo thư mục con, chặn ký tự cấm, báo rõ khi trùng tên", async () => {
  const root = mkdtempSync(join(tmpdir(), "ow-mkdir-"));
  try {
    const made = await makeDir(root, "Project Moi 2026");
    assert.equal(existsSync(join(root, "Project Moi 2026")), true);
    assert.match(made.path, /Project Moi 2026$/);
    await assert.rejects(() => makeDir(root, "a/b"), /ký tự/);
    await assert.rejects(() => makeDir(root, "Project Moi 2026"), /Đã có thư mục/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("logwipe: truncate giữ file, delete xóa hẳn, sang ngày mới thì dọn log cũ", () => {
  const dir = mkdtempSync(join(tmpdir(), "owm-logwipe-"));
  try {
    const p = (n) => join(dir, n);
    for (const n of LOG_NAMES) writeFileSync(p(n), "du lieu log cu");

    wipeLogs(dir); // tắt app khi bridge vẫn ghi: truncate, giữ file
    for (const n of LOG_NAMES) assert.equal(statSync(p(n)).size, 0);

    deleteLogs(dir); // sau khi bridge đã chết: xóa hẳn
    for (const n of LOG_NAMES) assert.equal(existsSync(p(n)), false);

    // boot: log mtime hôm qua bị dọn, log viết hôm nay giữ nguyên
    writeFileSync(p("bridge.log"), "hom qua");
    writeFileSync(p("bridge-task.log"), "hom nay");
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    utimesSync(p("bridge.log"), yesterday, yesterday);
    rotateStaleLogs(dir);
    assert.equal(statSync(p("bridge.log")).size, 0);
    assert.equal(statSync(p("bridge-task.log")).size, "hom nay".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
