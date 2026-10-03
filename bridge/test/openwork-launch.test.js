import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenWorkExeName, normalizeExePathInput } from "../src/openwork-launch.js";

// Chốt chặn RCE của route POST /api/openwork/path: path gõ từ điện thoại
// được lưu vào config.openworkExe, và config đó bị spawn() thật ở
// /api/openwork/wake + auto-launch lúc boot. exists + isFile là không đủ —
// chỉ đúng tên OpenWork.exe mới được lọt tới chỗ spawn.
test("isOpenWorkExeName: chỉ nhận đúng tên OpenWork.exe (không phân biệt hoa thường)", () => {
  assert.equal(isOpenWorkExeName("C:\\Users\\user\\AppData\\Local\\Programs\\@openworkdesktop\\OpenWork.exe"), true);
  assert.equal(isOpenWorkExeName("D:\\Apps\\OPENWORK.EXE"), true);
  assert.equal(isOpenWorkExeName("  C:\\Apps\\openwork.exe  "), true);
});

test("isOpenWorkExeName: chặn file thực thi khác + rác, kể cả file tồn tại", () => {
  assert.equal(isOpenWorkExeName("C:\\Windows\\System32\\calc.exe"), false);
  assert.equal(isOpenWorkExeName("C:\\Windows\\System32\\cmd.exe"), false);
  assert.equal(isOpenWorkExeName("C:\\Users\\user\\AppData\\Local\\Temp\\khong-phai-exe.txt"), false);
  assert.equal(isOpenWorkExeName("C:\\Apps\\OpenWork.exe.bak"), false);
  assert.equal(isOpenWorkExeName("C:\\Apps\\MyOpenWork.exe"), false);
  assert.equal(isOpenWorkExeName(""), false);
  assert.equal(isOpenWorkExeName(null), false);
  assert.equal(isOpenWorkExeName(undefined), false);
});

// Người dùng dán "Copy as path" từ PowerShell là đường dẫn CÓ dấu nháy kép.
// Không bóc ra thì existsSync() luôn false và họ tưởng mình gõ sai đường dẫn.
test("normalizeExePathInput: bóc dấu nháy kép / nháy đơn do copy từ shell", () => {
  const raw = '"C:\\Users\\user\\AppData\\Local\\Programs\\@openworkdesktop\\OpenWork.exe"';
  assert.equal(normalizeExePathInput(raw), "C:\\Users\\user\\AppData\\Local\\Programs\\@openworkdesktop\\OpenWork.exe");
  assert.equal(normalizeExePathInput("  'C:\\Apps\\OpenWork.exe'  "), "C:\\Apps\\OpenWork.exe");
  assert.equal(normalizeExePathInput('"\'C:\\Apps\\OpenWork.exe\'"'), "C:\\Apps\\OpenWork.exe");
  assert.equal(normalizeExePathInput('""C:\\Apps\\OpenWork.exe""'), "C:\\Apps\\OpenWork.exe");
});

test("normalizeExePathInput: đường dẫn thường giữ nguyên, rác thì rỗng", () => {
  assert.equal(normalizeExePathInput("C:\\Apps\\OpenWork.exe"), "C:\\Apps\\OpenWork.exe");
  assert.equal(normalizeExePathInput("  C:\\Apps\\OpenWork.exe  "), "C:\\Apps\\OpenWork.exe");
  assert.equal(normalizeExePathInput('C:\\Apps\\có "dấu" trong tên\\OpenWork.exe'), 'C:\\Apps\\có "dấu" trong tên\\OpenWork.exe');
  assert.equal(normalizeExePathInput('"'), '"', "một dấu nháy lẻ thì không phải nháy bao quanh, giữ nguyên");
  assert.equal(normalizeExePathInput('""'), "");
  assert.equal(normalizeExePathInput("   "), "");
  assert.equal(normalizeExePathInput(null), "");
  assert.equal(normalizeExePathInput(undefined), "");
});

// Sắp xếp lại để normalize phải chạy TRƯỚC isOpenWorkExeName: đường dẫn bọc
// nháy có basename là `OpenWork.exe"` nên tên file sai — nếu ai đó kiểm tra tên
// trước, chuỗi hợp lệ sẽ bị từ chối.
test("bóc nháy xong thì tên file phải khớp OpenWork.exe", () => {
  const raw = '"C:\\Apps\\OpenWork.exe"';
  assert.equal(isOpenWorkExeName(raw), false, "chưa bóc thì tên file có dấu nháy");
  assert.equal(isOpenWorkExeName(normalizeExePathInput(raw)), true);
});
