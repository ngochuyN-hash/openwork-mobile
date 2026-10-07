// Fixture hợp đồng 3 tầng (bridge / web / worker) — xem shared/contract.js.
//
// Cả BA tầng giờ đều nói chuyện bằng contract: bridge + web import trực tiếp,
// worker import qua esbuild bundle (wrangler). Test này giữ 2 lớp bảo vệ:
//  1. giá trị canonical trong shared/contract.js khóa cứng — đổi tên là phải
//     sửa chủ đích;
//  2. worker không được còn literal xuyên tầng trôi nổi (mã lỗi/header/?_m=
//     phải đi qua ErrorCode/header constants), và test relay của worker — vốn
//     chạy HTTP mock KHÔNG import contract — vẫn khẳng định ĐÚNG giá trị
//     canonical từ phía bên kia dây.
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

test("contract: worker đã import contract — không còn literal xuyên tầng trôi nổi", () => {
  const workerSrc = readFileSync(join(ROOT, "worker", "src", "index.js"), "utf8");
  assert.ok(
    workerSrc.includes('from "../../shared/contract.js"'),
    "worker/src/index.js phải import shared/contract.js"
  );
  // Mã lỗi xuyên tầng CHỈ được dùng qua ErrorCode.* — literal trôi nổi là drift.
  for (const literal of Object.values(ErrorCode)) {
    assert.ok(!workerSrc.includes(`code: "${literal}"`), `worker còn literal code: "${literal}"`);
  }
  for (const header of [HEADER_TENANT, HEADER_BRIDGE_SECRET, HEADER_INVITE]) {
    assert.ok(!workerSrc.includes(`"${header}"`), `worker còn literal header "${header}"`);
  }
  assert.ok(!workerSrc.includes('searchParams.get("_m")'), "worker còn literal ?_m=");
  // Bên bảo vệ thứ hai: test relay của worker chạy HTTP mock, KHÔNG import
  // contract — nó phải vẫn khẳng định ĐÚNG giá trị canonical từ phía dây.
  // (relay.test.mjs chỉ phủ 3 mã này: tunnel_down/bridge_offline được bảo vệ
  // bởi assert "không còn literal" ở trên.)
  const relayTest = readFileSync(join(ROOT, "worker", "test", "relay.test.mjs"), "utf8");
  for (const literal of ["tenant_required", "rate_limited", "invalid_credentials"]) {
    assert.ok(relayTest.includes(`"${literal}"`), `relay test mất assertion cho "${literal}"`);
  }
});

test("contract: sse.js cũng đi qua contract — không còn literal header trôi nổi", () => {
  // Sồn cuối của candidate 4 (review 07/10): dòng này từng hardcode
  // "x-owm-tenant" ngoài hợp đồng — đổi header một ngày nào đó thì SSE đứt
  // im lặng, không test nào bảo vệ. Giờ phải import HEADER_TENANT như api.js.
  const sseSrc = readFileSync(join(ROOT, "web", "src", "lib", "sse.js"), "utf8");
  assert.ok(
    sseSrc.includes('from "../../../shared/contract.js"'),
    "web/src/lib/sse.js phải import shared/contract.js"
  );
  assert.ok(!sseSrc.includes(`"${HEADER_TENANT}"`), "sse.js còn literal header ngoài contract");
});
