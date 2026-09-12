import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeDataDir } from "./config.js";

// Mô hình "Pair Device" học từ 9Remote (README của họ - source chưa opensource):
//   - One-Time Key : mã 8 ký tự, sống 30 phút, dùng đúng 1 lần, hiện trong QR
//                    trên terminal bridge. Đây chính là bước "duyệt thiết bị".
//   - Permanent Key: token `owd_...` vĩnh viễn, cấp cho thiết bị sau khi nhập
//                    đúng mã. Lưu ở điện thoại (localStorage) và dưới dạng HASH
//                    trong devices.json của bridge - thu hồi được từng cái.
// Token master `owm_` (cũ) vẫn dùng được như một thiết bị "admin" dự phòng.

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ 0/O/1/I chống đọc nhầm
const CODE_LENGTH = 8;
const CODE_TTL_MS = 30 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60_000;

export const CODE_TTL_MINUTES = CODE_TTL_MS / 60_000;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sameString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

function devicesFile() {
  return join(bridgeDataDir(), "devices.json");
}

function loadDevices() {
  const file = devicesFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.devices) ? parsed.devices.filter((d) => d?.id && d?.tokenHash) : [];
  } catch {
    return [];
  }
}

function saveDevices(devices) {
  const dir = bridgeDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = devicesFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, updatedAt: Date.now(), devices }, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export class PairingService {
  /**
   * @param {{now?: () => number, onCode?: (code: string, expiresAt: number) => void}} options
   */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.onCode = options.onCode;
    this.code = "";
    this.codeExpiresAt = 0;
    this.used = false;
    this.devices = loadDevices();
  }

  /** Luôn có sẵn một mã active; tự làm mới khi hết hạn/dùng rồi. */
  ensureCode() {
    if (!this.code || this.used || this.now() > this.codeExpiresAt) {
      this.code = generateCode();
      this.codeExpiresAt = this.now() + CODE_TTL_MS;
      this.used = false;
      this.onCode?.(this.code, this.codeExpiresAt);
    }
    return this.code;
  }

  codeSecondsLeft() {
    return Math.max(0, Math.floor((this.codeExpiresAt - this.now()) / 1000));
  }

  /**
   * Ghép thiết bị bằng mã one-time. Trả về {token, device} hoặc null (sai/hết mã).
   * @param {string} code do người dùng nhập
   * @param {string} label tên thiết bị (tùy chọn)
   */
  pair(code, label) {
    this.ensureCode();
    if (!code || this.used || this.now() > this.codeExpiresAt || !sameString(String(code).trim().toUpperCase(), this.code)) {
      return null;
    }
    this.used = true;
    const token = `owd_${randomBytes(24).toString("hex")}`;
    const device = {
      id: `d_${randomUUID().slice(0, 8)}`,
      label: String(label ?? "").trim().slice(0, 40) || `Thiết bị ${new Date(this.now()).toLocaleString("vi-VN")}`,
      tokenHash: sha256(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
    };
    this.devices.unshift(device);
    saveDevices(this.devices);
    this.ensureCode(); // mã vừa dùng -> làm mới mã mới cho thiết bị tiếp theo
    return { token, device: this.publicDevice(device) };
  }

  /** Xác thực token thiết bị (owd_...). Trả về device hoặc null. */
  authenticate(token) {
    if (!token) return null;
    const hash = sha256(token);
    const device = this.devices.find((d) => sameString(d.tokenHash, hash));
    if (!device) return null;
    if (this.now() - device.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
      device.lastSeenAt = this.now();
      saveDevices(this.devices);
    }
    return this.publicDevice(device);
  }

  revoke(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== before) saveDevices(this.devices);
    return this.devices.length !== before;
  }

  list() {
    return this.devices.map((d) => this.publicDevice(d));
  }

  publicDevice(device) {
    const { tokenHash: _hash, ...rest } = device;
    return rest;
  }
}
