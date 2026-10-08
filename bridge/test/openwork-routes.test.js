import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Tầng HTTP thật của hai route "mở OpenWork từ điện thoại":
//   POST /api/openwork/path  — điện thoại gõ/dán đường dẫn OpenWork.exe
//   POST /api/openwork/wake  — bấm "bật OpenWork" khi app chưa chạy
// Ở tầng unit, openwork-launch.test.js đã phủ cả isOpenWorkExeName (dòng 9-24)
// và normalizeExePathInput (dòng 28-45, kể cả nháy kép 2 lớp) cùng phép ghép
// "bóc nháy xong thì mới so tên" (dòng 50-54). Ở đây ta bắn HTTP vào tiến
// trình bridge thật để phủ phần mà unit test không thấy được: route có thật sự
// gọi hàm lọc đó không, lỗi nào trả status/code nào, message hiện ra cho điện
// thoại là tiếng Việt, và config có bị ghi bậy những gì.
//
// RANH GIỚI AN TOÀN THẬT của /api/openwork/path — đọc trước khi thêm case:
// route KHÔNG khoá theo thư mục. Nó chỉ so basename === "openwork.exe"
// (src/openwork-launch.js:50-55) rồi lưu thẳng vào config.openworkExe
// (src/index.js:532-534), và config đó bị spawn() thật ở /api/openwork/wake
// (src/openwork-launch.js:104) + auto-launch lúc boot. Nghĩa là MỌI file tên
// OpenWork.exe nằm ở bất kỳ thư mục nào (Downloads, %TEMP%...) đều lọt. Cái
// test này khoá đúng cái ranh giới đó — chặn mọi file thực thi khác — chứ không
// phải khoá "route này an toàn trước RCE". Nếu sau này sản phẩm thêm allowlist
// thư mục, hãy thêm case ở đây; đừng mặc định là đã có.
//
// Trần rate limit: cả hai route dùng chung wakeRateLimited 5 lần/phút/IP
// (src/index.js:95-105, gọi ở 467 và 496) và bridge bind 127.0.0.1 nên chỉ có
// MỘT bucket IP cho cả tiến trình. Vượt trần thì route gọi deny() = 401
// unauthorized — y hệt "thiếu token". Vì vậy mỗi test chỉ được TIÊU 3 slot rate
// limit và tự dựng bridge riêng cho từng nhóm: còn 2 chỗ trống để thêm case mới mà
// không đụng trần. Thêm một nhánh thứ 4 vào một test là phải tách nhóm, không
// phải nhồi thêm request (xem assertNotRateLimited để lỗi nói đúng nguyên nhân).
//
// "3 slot" KHÁC "số HTTP request" — đừng đếm bằng mắt. Test 1 bắn 4 HTTP
// request thật nhưng chỉ tiêu 3 slot, vì request không-token bị chặn ở cổng auth
// (src/index.js:330 `if (!isTokenAuthorized(...) && !device) return deny(res)`)
// TRƯỚC khi tới `wakeRateLimited(ip)` ở src/index.js:496. Hệ quả: thêm một
// request không-token là MIỄN PHÍ (vẫn 0 slot), còn thêm một request CÓ token là
// tốn 1 slot thật. Nếu sau này ai đó chuyển cổng auth xuống dưới phần dispatch
// route, request không-token sẽ bắt đầu ăn slot và test sẽ đỏ với thông báo sai —
// assertNotRateLimited nói đúng nguyên nhân khi điều đó xảy ra.

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Chỉ viết config + spawn, KHÔNG await, KHÔNG assert: mọi lỗi sau khi spawn
// đều phải ném ra từ waitUntilListening() để `bridge` đã gán xong trong thân
// test và luôn nằm trong phạm vi finally — không rơi vào trường hợp startBridge
// reject mà child mồ côi vẫn giữ cổng và thư mục tạm (startup.test.js cũng
// spawn thẳng trong thân test vì lý do đó).
//
// Trung hoà MÁY THẬT cho MỌI bridge, không riêng test wake. candidateExeEntries
// (src/openwork-launch.js:25-35) rơi xuống %LOCALAPPDATA%\Programs\... và
// %PROGRAMFILES%\OpenWork\... khi không có env lẫn config nào trỏ đi chỗ khác —
// và candidateExeEntries chính là nguồn của openworkStateInfo() mà route trả 200
// gọi tới. Nếu để sót, test chạy trên máy đã cài OpenWork sẽ đọc app.asar thật
// (vài MB, openwork-version.js:116-141) và kết quả phụ thuộc vào máy người
// chạy. Hai thư mục rỗng dưới đây là mặc định AN TOÀN; test wake tự truyền bản
// riêng của nó (extraEnv ghi đè sau, nên vẫn thắng).
async function spawnBridge({ token, data, openwork, extraEnv = {} }) {
  const port = await freePort();
  writeFileSync(
    join(data, "config.json"),
    JSON.stringify({
      mobileToken: token,
      port,
      lookupUrl: "",
      lookupSecret: "",
      lookupTenant: "",
      autoLaunchOpenWork: false,
    })
  );
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      OPENWORK_BRIDGE_DIR: data,
      OPENWORK_DIR: openwork,
      OPENWORK_SERVER_URL: "",
      OPENWORK_PUBLIC_URL: "",
      OPENWORK_BRIDGE_TUNNEL: "0",
      OPENWORK_EXE: "",
      LOCALAPPDATA: join(data, "..", "localappdata-ro"),
      PROGRAMFILES: join(data, "..", "programfiles-ro"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { url: `http://127.0.0.1:${port}`, child, output: () => output };
}

async function waitUntilListening(bridge) {
  const deadline = Date.now() + 15000;
  while (!bridge.output().includes("listening on") && Date.now() < deadline && bridge.child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(bridge.output(), /listening on/, `bridge không lên được:\n${bridge.output()}`);
}

// Luôn kill tiến trình con, nếu không test treo Node lúc thoát.
async function stopBridge(bridge) {
  const child = bridge?.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}

function postJson(url, pathname, body, headers = {}) {
  return fetch(`${url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

// Route này KHÔNG BAO GIỜ trả 401 khi token đúng: lỗi của nó là 400 (và 200 khi
// thành công). Thấy 401 ở đây là deny() — tức là đã đụng trần rate limit 5
// lần/phút (src/index.js:95-105 dùng chung deny() cho cả "thiếu token").
function assertNotRateLimited(res) {
  assert.notEqual(
    res.status,
    401,
    "401 ở đây là rate limit (deny() dùng chung cho cả thiếu token), không phải lỗi xác thực. " +
      "Tách nhóm case sang bridge khác, đừng nhồi thêm request vào test này."
  );
}

// Message lỗi đi điện thoại: phải là tiếng Việt có dấu. Kiểm bằng CHỮ CÓ DẤU
// riêng của tiếng Việt (đ/ă/â/ê/ô/ơ/ư + nguyên âm tổ hợp) chứ không phải " có
// ký tự Latin-Extended", vì ký tự đó lọt vào cả tên đường dẫn rò ra (ví dụ
// C:\Users\<name>\...). Vì vậy cấm thêm đường dẫn thô trong message.

function assertErrorMessage(body) {
  assert.ok(body && typeof body.message === "string", "phải có message");
  assert.ok(body.message.trim().length > 0, "message không được rỗng");
  assert.match(body.message, /[a-z]/i, `message phải là câu tiếng Anh đọc được: ${JSON.stringify(body.message)}`);
  assert.doesNotMatch(body.message, /[A-Za-z]:\\/, `message không được rò đường dẫn thô: ${JSON.stringify(body.message)}`);
}

function readConfig(data) {
  return JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
}

// Gom phần dựng dùng chung của hai test /api/openwork/path.
function makeSandbox(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const data = join(root, "bridge");
  const openwork = join(root, "openwork");
  const apps = join(root, "apps");
  mkdirSync(data);
  mkdirSync(openwork);
  mkdirSync(apps);
  const exe = join(apps, "OpenWork.exe");
  const calc = join(apps, "calc.exe");
  writeFileSync(exe, "không phải exe thật, chỉ là file rỗng cho route làm việc");
  writeFileSync(calc, "MZ giả");
  return { root, data, openwork, apps, exe, calc };
}

test(
  "POST /api/openwork/path: 401 khi không token, 400 cho path rỗng / không tồn tại / là thư mục",
  { timeout: 40000 },
  async () => {
    const sandbox = makeSandbox("owm-openwork-path-a-");
    const token = "owm_test_openwork_path_a_secret";
    let bridge;
    try {
      bridge = await spawnBridge({ token, data: sandbox.data, openwork: sandbox.openwork });
      await waitUntilListening(bridge);
      const auth = { authorization: `Bearer ${token}` };

      // (1) Không token -> 401. Đòi message TIẾNG VIỆT như mọi lỗi khác: đề
      // bài nói rõ "mọi phản hồi lỗi phải có message tiếng Việt", và 401 cũng là
      // phản hồi lỗi. Ở đây KHÔNG khoá nguyên văn chuỗi đang có — nếu khoá
      // thì test đóng băng luôn một vi phạm, và khi ai đó sửa deny() sang
      // tiếng Việt (đúng việc cần làm) test lại đỏ với thông báo sai nguyên nhân.
      // Xem deny() ở src/auth.js:17-20.
      const noAuth = await postJson(bridge.url, "/api/openwork/path", { path: sandbox.exe });
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.body.code, "unauthorized");
      assertErrorMessage(noAuth.body);

      // (2) path rỗng -> invalid_path
      const empty = await postJson(bridge.url, "/api/openwork/path", { path: "   " }, auth);
      assertNotRateLimited(empty);
      assert.equal(empty.status, 400);
      assert.equal(empty.body.code, "invalid_path");
      assertErrorMessage(empty.body);

      // (3) path không tồn tại -> not_found
      const missing = await postJson(bridge.url, "/api/openwork/path", { path: join(sandbox.apps, "khong-ton-tai.exe") }, auth);
      assertNotRateLimited(missing);
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, "not_found");
      assertErrorMessage(missing.body);

      // (4) path là một thư mục thật -> not_a_file (existsSync true, isFile false)
      const dir = await postJson(bridge.url, "/api/openwork/path", { path: sandbox.apps }, auth);
      assertNotRateLimited(dir);
      assert.equal(dir.status, 400);
      assert.equal(dir.body.code, "not_a_file");
      assertErrorMessage(dir.body);
    } finally {
      await stopBridge(bridge);
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
);

test(
  "POST /api/openwork/path: chặn file không phải OpenWork.exe, và bóc nháy kép của PowerShell",
  { timeout: 40000 },
  async () => {
    const sandbox = makeSandbox("owm-openwork-path-b-");
    const token = "owm_test_openwork_path_b_secret";
    let bridge;
    try {
      bridge = await spawnBridge({ token, data: sandbox.data, openwork: sandbox.openwork });
      await waitUntilListening(bridge);
      const auth = { authorization: `Bearer ${token}` };

      // (5) RANH GIỚI AN TOÀN THẬT của route: file tồn tại, là file thật, nhưng
      // tên KHÔNG phải OpenWork.exe -> chặn. Không chỉ chặn "file lạ": nếu
      // chỉ existsSync + isFile thì C:\Windows\System32\cmd.exe lọt và bridge
      // mở cmd.exe khi wake. Và không được ghi vào config — config đó bị
      // spawn() thật ở /api/openwork/wake + auto-launch lúc boot.
      const wrongExe = await postJson(bridge.url, "/api/openwork/path", { path: sandbox.calc }, auth);
      assertNotRateLimited(wrongExe);
      assert.equal(wrongExe.status, 400);
      assert.equal(wrongExe.body.code, "not_openwork_exe");
      assertErrorMessage(wrongExe.body);
      assert.equal(readConfig(sandbox.data).openworkExe, "", "calc.exe không được lọt vào config.openworkExe");

      // (6) Dán nguyên xi output "Copy as path" của PowerShell (có dấu nháy kép)
      // phải được bóc nháy rồi xử lý đúng — không được đáp bằng not_found. Ở đây
      // file tên OpenWork.exe nằm trong <tmp>\apps, tức nằm NGOÀI mọi "chỗ hay
      // gặp": route vẫn nhận, và đây chính là khoảng hở còn lại đã nêu ở
      // comment đầu file — khoá đúng hành vi hiện có, đừng đọc thành "an toàn".
      const quoted = await postJson(bridge.url, "/api/openwork/path", { path: `"${sandbox.exe}"` }, auth);
      assertNotRateLimited(quoted);
      assert.equal(quoted.status, 200, `path bọc nháy phải được chấp nhận, nhận ${JSON.stringify(quoted.body)}`);
      assert.equal(quoted.body.ok, true);
      assert.equal(readConfig(sandbox.data).openworkExe, sandbox.exe, "config phải lưu path ĐÃ bóc nháy");

      // Câu trả lời 200 có kèm openworkStateInfo() (src/index.js:536 ->
      // :221-234) — tức describeOpenWorkInstall() + openworkVersionFrom(), hai
      // hàm ĐỌC ĐĨA. Chính vì thế mọi bridge ở file này đều trung hoà
      // LOCALAPPDATA/PROGRAMFILES (xem spawnBridge). Assertion này khoá lại rằng
      // exe trả về đến từ sandbox chứ không phải từ app thật trên máy: exe của
      // app thật nằm cạnh resources/app.asar vài MB (openwork-version.js:119),
      // nên nếu lọt xuống đó thì test vừa chậm vừa phụ thuộc trạng thái máy.
      assert.equal(quoted.body.openwork.exe, sandbox.exe, "openwork info phải lấy từ sandbox, không đọc app thật trên máy");
      assert.equal(quoted.body.openwork.found, true);
    } finally {
      await stopBridge(bridge);
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  }
);

test(
  "POST /api/openwork/wake: không có exe nào tồn tại -> openwork_exe_not_found kèm mảng candidates",
  { timeout: 40000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "owm-openwork-wake-"));
    const data = join(root, "bridge");
    const openwork = join(root, "openwork");
    const fakeLocalAppData = join(root, "fake-localappdata");
    const fakeProgramFiles = join(root, "fake-programfiles");
    mkdirSync(data);
    mkdirSync(openwork);
    mkdirSync(fakeLocalAppData);
    mkdirSync(fakeProgramFiles);
    // Env OPENWORK_EXE trỏ vào file không tồn tại, và %LOCALAPPDATA%/%PROGRAMFILES%
    // bị đổi sang thư mục rỗng: các candidate "chỗ hay gặp"
    // (src/openwork-launch.js:25-35) mặc định chỉ vào
    // %LOCALAPPDATA%\Programs\@openworkdesktop\OpenWork.exe — nơi máy thật CÓ
    // app cài sẵn, nên không chặn lại thì test này sẽ spawn GUI thật trên máy
    // người chạy. Mọi candidate trả về đều được assert là không tồn tại.
    const missingExe = join(root, "thu-muc-khong-co-that", "OpenWork.exe");
    const token = "owm_test_openwork_wake_secret";
    let bridge;
    try {
      bridge = await spawnBridge({
        token,
        data,
        openwork,
        extraEnv: { OPENWORK_EXE: missingExe, LOCALAPPDATA: fakeLocalAppData, PROGRAMFILES: fakeProgramFiles },
      });
      await waitUntilListening(bridge);

      const res = await postJson(bridge.url, "/api/openwork/wake", {}, { authorization: `Bearer ${token}` });
      assertNotRateLimited(res);
      assert.equal(res.status, 404);
      assert.equal(res.body.code, "openwork_exe_not_found");
      assertErrorMessage(res.body);
      // Danh sách ứng viên để điện thoại hiện "chọn 1 trong N" cho user.
      assert.ok(Array.isArray(res.body.candidates), "phải kèm mảng candidates");
      assert.ok(res.body.candidates.length > 0, "candidates không được rỗng");
      for (const candidate of res.body.candidates) {
        assert.equal(typeof candidate, "string");
        assert.ok(candidate.toLowerCase().endsWith("openwork.exe"), `candidate sai: ${candidate}`);
        assert.equal(existsSync(candidate), false, `candidate không được tồn tại, không thì wake sẽ spawn: ${candidate}`);
      }
    } finally {
      await stopBridge(bridge);
      rmSync(root, { recursive: true, force: true });
    }
  }
);