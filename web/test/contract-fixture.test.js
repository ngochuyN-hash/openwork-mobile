// Fixture hợp đồng 3 tầng (bridge / web / worker) — xem shared/contract.js.
//
// Worker CHƯA import được contract (đang giữa đợt WIP — esbuild bundle theo
// relative import ra ngoài worker/ là được, nhưng chưa chuyển), nên những giá
// trị worker phát ra vẫn là literal trong worker/src/index.js. Test này KHOÁ
// literal đó vào giá trị canonical: ai đổi mã lỗi/header ở worker mà quên đổi
// contract (hoặc ngược lại) thì test đỏ NGAY — đúng cái trôi dạt mà review
// kiến trúc 03/10 (candidate 4) lo. Khi worker đã `import ... from
// "../../shared/contract.js"` thì thay phần khoá literal bằng assert worker
// không còn literal trôi nổi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PAIR_CODE_HASH,
  MASTER_TOKEN_HASH,
  TENANT_HASH_KEY,
  TENANT_QUERY_KEY,
  HEADER_TENANT,
  HEADER_BRIDGE_SECRET,
  HEADER_INVITE,
  ErrorCode,
  TOKEN_PREFIX_SOURCE,
  buildPairingUrl,
} from "../../shared/contract.js";
import { parseHashParam } from "../src/lib/route.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("contract: giá trị canonical khóa cứng — đổi tên là phải sửa chủ đích", () => {
  assert.equal(PAIR_CODE_HASH, "p");
  assert.equal(MASTER_TOKEN_HASH, "t");
  assert.equal(TENANT_HASH_KEY, "m");
  assert.equal(TENANT_QUERY_KEY, "_m");
  assert.equal(HEADER_TENANT, "x-owm-tenant");
  assert.equal(HEADER_BRIDGE_SECRET, "x-owm-secret");
  assert.equal(HEADER_INVITE, "x-owm-invite");
  assert.equal(ErrorCode.TENANT_REQUIRED, "tenant_required");
  assert.equal(ErrorCode.NOT_JOINED, "not_joined");
  assert.equal(ErrorCode.TUNNEL_DOWN, "tunnel_down");
  assert.equal(ErrorCode.INVALID_CREDENTIALS, "invalid_credentials");
  assert.equal(ErrorCode.RATE_LIMITED, "rate_limited");
  assert.equal(ErrorCode.BRIDGE_OFFLINE, "bridge_offline");
  assert.equal(ErrorCode.INVITE_REQUIRED, "invite_required");
  assert.equal(ErrorCode.INVALID_BODY, "invalid_body");
  assert.equal(TOKEN_PREFIX_SOURCE, "(?:owm|owd|owt)_");
});

test("contract: link bridge dựng thì web parser đọc được (build -> parse roundtrip)", () => {
  const pair = buildPairingUrl({ base: "https://room.example.workers.dev/", value: "AB12CD34", tenant: "pc-ab12cd" });
  assert.equal(pair, "https://room.example.workers.dev/#p=AB12CD34&m=pc-ab12cd");
  const parsed = parseHashParam(new URL(pair).hash, PAIR_CODE_HASH);
  assert.deepEqual(parsed, { value: "AB12CD34", tenant: "pc-ab12cd" });

  const master = buildPairingUrl({ base: "http://127.0.0.1:8788", kind: "master", value: "owm_deadbeef", tenant: "" });
  assert.equal(master, "http://127.0.0.1:8788/#t=owm_deadbeef");
  const masterParsed = parseHashParam(new URL(master).hash, MASTER_TOKEN_HASH);
  assert.deepEqual(masterParsed, { value: "owm_deadbeef", tenant: "" });
});

test("contract: worker phát đúng mã lỗi/header như contract (khoá literal tới khi worker import contract)", () => {
  const workerSrc = readFileSync(join(ROOT, "worker", "src", "index.js"), "utf8");
  // Mỗi mã lỗi xuyên tầng: literal trong worker PHẢI đúng bằng giá trị canonical.
  const workerCodes = {
    TENANT_REQUIRED: "tenant_required",
    TUNNEL_DOWN: "tunnel_down",
    INVALID_CREDENTIALS: "invalid_credentials",
    RATE_LIMITED: "rate_limited",
    BRIDGE_OFFLINE: "bridge_offline",
    INVITE_REQUIRED: "invite_required",
  };
  for (const [key, literal] of Object.entries(workerCodes)) {
    assert.equal(ErrorCode[key], literal, `ErrorCode.${key} trôi khỏi worker: ${literal}`);
    assert.ok(workerSrc.includes(`"${literal}"`), `worker mất mã lỗi "${literal}"`);
  }
  for (const header of [HEADER_TENANT, HEADER_BRIDGE_SECRET, HEADER_INVITE]) {
    assert.ok(workerSrc.includes(header), `worker mất header ${header}`);
  }
  assert.ok(workerSrc.includes(TENANT_QUERY_KEY), "worker mất query key ?_m=");
});
