import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeOpenWorkInstall, openworkVersionFrom, readAsarPackageJson } from "../src/openwork-version.js";

// Toàn bộ test dựng file .asar GIẢ trong thư mục tạm — không bao giờ đụng tới
// %LOCALAPPDATA% hay bản OpenWork thật trên máy. Bố cục asar thật (Chromium
// Pickle): [0..4)=4, [4..8)=headerSize, [8..12)=payload size, [12..16)=len JSON,
// [16..)=JSON đệm tròn 4 byte, rồi tới payload file.
function writeFakeAsar(dir, { version = "0.18.54", corruptJson = false, declaredJsonLength, nest = false } = {}) {
  const resources = join(dir, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(dir, "OpenWork.exe"), "MZ-fake-exe");

  const payload = Buffer.from(JSON.stringify({ name: "openwork", productName: "OpenWork", version }), "utf8");
  const entry = { size: String(payload.length), offset: "0" };
  // nest=true: package.json nằm trong files.app.files (một số bản build dựng
  // app.asar lồng thư mục) thay vì ngay gốc.
  const header = { files: nest ? { app: { files: { "package.json": entry } } } : { "package.json": entry } };
  const json = Buffer.from(corruptJson ? '{"files":{"package.json":{"size":1,"offset":"0"}}' : JSON.stringify(header), "utf8");
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + padded.length, 4);
  prefix.writeUInt32LE(4 + padded.length, 8);
  prefix.writeUInt32LE(declaredJsonLength ?? json.length, 12);

  const asar = join(resources, "app.asar");
  writeFileSync(asar, Buffer.concat([prefix, padded, payload]));
  return { asar, exe: join(dir, "OpenWork.exe") };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "owm-openwork-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Trên máy dev thật sự ĐANG có OpenWork ở %LOCALAPPDATA%\Programs — test
// "không tìm thấy" phải tự chủ đạo, nên trỏ LOCALAPPDATA/PROGRAMFILES vào
// thư mục tạm rỗng thay vì để nó đọc ổ đĩa thật.
function withoutEnvExe(fn) {
  const saved = process.env.OPENWORK_EXE;
  delete process.env.OPENWORK_EXE;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OPENWORK_EXE;
    else process.env.OPENWORK_EXE = saved;
  }
}

function withEmptyWellknownPaths(dir, fn) {
  const empty = join(dir, "empty-localappdata");
  mkdirSync(empty, { recursive: true });
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, PROGRAMFILES: process.env.PROGRAMFILES };
  process.env.LOCALAPPDATA = empty;
  process.env.PROGRAMFILES = join(dir, "empty-programfiles");
  try {
    return fn();
  } finally {
    for (const key of ["LOCALAPPDATA", "PROGRAMFILES"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("asar giả: đọc được package.json và version OpenWork trong resources/", () => {
  withTempDir((dir) => {
    const { asar, exe } = writeFakeAsar(dir, { version: "0.18.54" });
    assert.deepEqual(readAsarPackageJson(asar), { name: "openwork", productName: "OpenWork", version: "0.18.54" });
    // openworkVersionFrom tự dò resources/app.asar cạnh file .exe
    assert.equal(openworkVersionFrom(exe), "0.18.54");
  });
});

test("asar giả: header JSON dài lệch byte đệm vẫn ra payload đúng chỗ", () => {
  withTempDir((dir) => {
    // len JSON không tròn 4 byte — payload phải nằm sau byte đệm, đọc thiếu
    // đệm là đọc lệch -> JSON hỏng.
    const { exe } = writeFakeAsar(dir, { version: "1.2.34567" });
    assert.equal(openworkVersionFrom(exe), "1.2.34567");
  });
});

test("asar giả: file .exe không có resources thì version là chuỗi rỗng", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "OpenWork.exe"), "MZ-fake-exe");
    assert.equal(openworkVersionFrom(join(dir, "OpenWork.exe")), "");
    assert.equal(openworkVersionFrom(""), "");
    assert.equal(openworkVersionFrom(join(dir, "khong-ton-tai.exe")), "");
  });
});

test("asar giả: file thiếu / header bị cắt cụt / JSON hỏng đều trả null, không ném", () => {
  withTempDir((dir) => {
    // File không tồn tại
    assert.equal(readAsarPackageJson(join(dir, "resources", "app.asar")), null);
    assert.equal(readAsarPackageJson(""), null);

    // File nhỏ hơn 16 byte header
    const tiny = join(dir, "tiny.asar");
    writeFileSync(tiny, Buffer.alloc(9));
    assert.equal(readAsarPackageJson(tiny), null);

    // Header khai báo JSON dài hơn chính file (tải vội bị cắt)
    const { asar } = writeFakeAsar(dir, { version: "9.9.9" });
    writeFileSync(join(dir, "truncated.asar"), readFileSync(asar).subarray(0, 24));
    assert.equal(readAsarPackageJson(join(dir, "truncated.asar")), null);

    // JSON hỏng (thiếu dấu ngoặc)
    const broken = writeFakeAsar(join(dir, "broken"), { corruptJson: true });
    assert.equal(readAsarPackageJson(broken.asar), null);

    // Không phải asar (byte đầu sai) — ví dụ lỡ trỏ nhầm vào file .exe
    const notAsar = join(dir, "not-an-asar.bin");
    writeFileSync(notAsar, Buffer.alloc(64, 7));
    assert.equal(readAsarPackageJson(notAsar), null);

    // len JSON khai báo vượt trần (HEADER_MAX_BYTES). PHẢI đọc đúng file
    // writeFakeAsar trả về — nó nằm ở <dir>\huge\resources\app.asar, đọc
    // <dir>\huge.asar thì trả null vì file không tồn tại, tức assertion pass
    // vì lý do khác và guard trần không còn test bảo vệ.
    const huge = writeFakeAsar(join(dir, "huge"), { declaredJsonLength: 1024 * 1024 * 512 });
    assert.equal(readAsarPackageJson(huge.asar), null);
  });
});

test("cache version: đổi app.asar (nâng cấp app) thì đọc lại, không trả version cũ", () => {
  withTempDir((dir) => {
    const { exe } = writeFakeAsar(dir, { version: "0.18.54" });
    assert.equal(openworkVersionFrom(exe), "0.18.54");
    // version dài khác → size app.asar khác → stamp đổi, cache tự vô hiệu hoá
    writeFakeAsar(dir, { version: "0.19.0-rc.123456" });
    assert.equal(openworkVersionFrom(exe), "0.19.0-rc.123456");
  });
});

test("asar giả: package.json nằm trong thư mục con vẫn tìm thấy", () => {
  withTempDir((dir) => {
    const { asar } = writeFakeAsar(dir, { version: "0.1.2", nest: true });
    assert.equal(readAsarPackageJson(asar).version, "0.1.2");
  });
});

test("describeOpenWorkInstall: source = config khi path trong config tồn tại", () => {
  withTempDir((dir) => {
    withoutEnvExe(() => {
      const { exe } = writeFakeAsar(dir, { version: "0.18.54" });
      const info = describeOpenWorkInstall({ configOpenworkExe: exe });
      assert.equal(info.found, true);
      assert.equal(info.exe, exe);
      assert.equal(info.version, "0.18.54");
      assert.equal(info.source, "config");
    });
  });
});

test("describeOpenWorkInstall: env OPENWORK_EXE thắng config (và source = env)", () => {
  withTempDir((dir) => {
    const saved = process.env.OPENWORK_EXE;
    try {
      const { exe } = writeFakeAsar(dir, { version: "0.19.0" });
      process.env.OPENWORK_EXE = exe;
      const info = describeOpenWorkInstall({ configOpenworkExe: "C:\\khong\\ton-tai.exe" });
      assert.equal(info.found, true);
      assert.equal(info.exe, exe);
      assert.equal(info.source, "env");
      assert.equal(info.version, "0.19.0");
    } finally {
      if (saved === undefined) delete process.env.OPENWORK_EXE;
      else process.env.OPENWORK_EXE = saved;
    }
  });
});

test("describeOpenWorkInstall: không thấy file nào thì found=false, version rỗng", () => {
  withTempDir((dir) => {
    withoutEnvExe(() =>
      withEmptyWellknownPaths(dir, () => {
        const info = describeOpenWorkInstall({ configOpenworkExe: join(dir, "khong-co.exe") });
        assert.equal(info.found, false);
        assert.equal(info.exe, "");
        assert.equal(info.version, "");
        assert.equal(info.source, "");
      })
    );
  });
});