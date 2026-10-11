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
  REGISTER_PATH,
  ErrorCode,
  TOKEN_PREFIX_SOURCE,
  normalizeTenant,
  buildPairingUrl,
  STATE_SHAPE,
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
  // Mã exe desktop so trong Provisioning.ErrorText (nhập ErrorCode 07/10):
  assert.equal(ErrorCode.TAKEN, "taken");
  assert.equal(ErrorCode.FULL, "full");
  assert.equal(ErrorCode.ROOM_CREATE_DISABLED, "room_create_disabled");
  // Cửa đăng ký tunnel bridge→worker (nhập hợp đồng 07/10):
  assert.equal(REGISTER_PATH, "/__register");
  assert.equal(normalizeTenant("  PC-Ab12 "), "pc-ab12");
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

test("contract: web gọi API qua BRIDGE_ROUTES — không còn literal đường trôi nổi", () => {
  // Candidate 3 (review 09/10): 13 fetch tay trong api.js + 1 raw fetch ở
  // pairing.jsx + 2 tiền tố proxy ở chat/sessions từng gõ tay — bridge đổi
  // đường là web gọi 404 và không test nào bắt. Giờ mọi đường đi qua hằng
  // contract (BRIDGE_ROUTES / OW_PROXY_PREFIX), cùng nguồn với exe desktop
  // (RoutePaths.cs sinh từ cùng file).
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const rel of [
    join("web", "src", "api.js"),
    join("web", "src", "pages", "pairing.jsx"),
    join("web", "src", "pages", "chat.jsx"),
    join("web", "src", "pages", "sessions.jsx"),
  ]) {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    assert.ok(!/["'`]\/api\//.test(code), `${rel} còn literal đường /api/... ngoài contract`);
  }
  const apiSrc = readFileSync(join(ROOT, join("web", "src", "api.js")), "utf8");
  assert.ok(apiSrc.includes("BRIDGE_ROUTES"), "api.js phải dùng BRIDGE_ROUTES");
  assert.ok(apiSrc.includes("OW_PROXY_PREFIX"), "api.js phải dùng OW_PROXY_PREFIX cho proxy engine");
});

test("contract: web chuẩn hoá phòng qua normalizeTenant — không còn luật riêng", () => {
  // Divergence sống 09/10: màn login từng strip [^a-z0-9-] TRÊN CẢ rule của
  // contract, api.js tự chép trim+lowercase — phòng có dấu cách/underscore
  // chuẩn hoá khác nhau giữa web và worker → tra KV trượt im lặng. Giờ cả hai
  // file phải import normalizeTenant và không ai được luật riêng nữa.
  for (const rel of [join("web", "src", "api.js"), join("web", "src", "pages", "pairing.jsx")]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(src.includes("normalizeTenant"), `${rel} phải dùng normalizeTenant của contract`);
    assert.ok(!/\[\^a-z0-9-\]/.test(src), `${rel} còn luật strip phòng riêng ngoài contract`);
  }
});

test("contract: web chỉ đọc /api/state trong STATE_SHAPE — field lạ là drift im lặng", () => {
  // Round 5 (11/10): shape của /api/state là kiến thức bridge↔web không ai
  // ghim — web đọc từng field, bridge đổi tên một field là `undefined` im
  // lặng (bridge/test/state-shape.test.js ghim PHÍA SẢN XUẤT; test này ghim
  // PHÍA TIÊU THỤ). app.jsx + settings.jsx là hai consumer chính: mọi truy
  // cập `state.X` / `state?.X` (kèm hop thứ hai tunnel/openwork/edge/…)
  // phải nằm trong STATE_SHAPE. Strip comment TRƯỚC khi scan — comment giải
  // thích chứa tên field là trúng oan (bài học đã gặp hai lần).
  // Strip KHỐ lẫn INLINE comment (bản cũ chỉ strip comment cả dòng — inline
  // `// ... state.js ...` sau code là trúng oan). `\s//` né được "https://"
  // (dấu // trong URL không có khoảng trắng đứng trước).
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s\/\/.*$/gm, "");
  const topKeys = Object.keys(STATE_SHAPE);
  // `error` là field web TỰ GHÉP vào state khi poll hỏng (app.jsx refreshState:
  // `setState({ ok: false, error: ... })`) — không phải field bridge trả, nên
  // không nằm trong STATE_SHAPE (shape phía dây). Cho phép biết tên ở đây thay
  // vì nhét vào hợp đồng wire.
  const CLIENT_STATE_FIELDS = ["error"];
  const allowed = [...topKeys, ...CLIENT_STATE_FIELDS];
  const nestedOf = (name) =>
    STATE_SHAPE[name] && typeof STATE_SHAPE[name] === "object" ? Object.keys(STATE_SHAPE[name]) : null;
  for (const rel of [join("web", "src", "app.jsx"), join("web", "src", "pages", "settings.jsx")]) {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    // Lookbehind chặn `settings-state.js` trong import path (state đứng sau
    // dấu - / . / quote là tên file, không phải truy cập state).
    for (const m of code.matchAll(/(?<![\w."'/-])state\s*(\?)?\.\s*(\w+)((\?)?\.\s*\w+)?/g)) {
      const top = m[2];
      assert.ok(allowed.includes(top), `${rel} đọc state.${top} — ngoài STATE_SHAPE (shared/contract.js)`);
      if (m[3]) {
        const sub = nestedOf(top);
        const second = m[3].replace(/^[\s?]*/, "").replace(/^\./, "").trim();
        if (sub) {
          assert.ok(
            sub.includes(second),
            `${rel} đọc state.${top}.${second} — ngoài STATE_SHAPE.${top}`
          );
        }
      }
    }
  }
});
