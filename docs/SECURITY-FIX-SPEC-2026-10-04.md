# Spec sửa lỗi bảo mật — audit 04/10/2026

Nguồn: audit toàn diện 3 tầng (worker → bridge → web) ngày 04/10/2026, gồm cả
thử sống trên bridge đang chạy (mọi API không token = 401, 38/38 test XSS pass).
Kết luận chung: **không có lỗ hổng nghiêm trọng** (không XSS, không SSRF, không
đọc file tùy ý). Spec này chỉ liệt kê những gì CẦN SỬA, theo thứ tự ưu tiên.

| # | Mức | Vấn đề | Chỗ sửa | Deploy |
|---|-----|--------|---------|--------|
| FIX-1 | Vừa | `/api/pairing-code` trả master token cho device key | bridge | restart bridge |
| FIX-2 | Vừa | Web qua tunnel không có CSP/security headers | bridge (+worker +1 header) | restart bridge + deploy CF |
| FIX-3 | Nhỏ | `/api/pair` chưa rate-limit theo IP ở worker; bucket bridge dùng chung | worker | deploy CF |
| FIX-4 | Nhỏ | `/api/tenant/create` mở công khai + race cướp tên phòng | worker | deploy CF (+ set `ALLOW_ROOM_CREATE`) |

Quy ước chung mọi FIX (theo luật dự án):

- Mỗi FIX = 1 commit riêng, dòng đầu 1 câu ngắn (tiếng Anh), chi tiết để CODE_SUMMARY.
- Cùng commit đó phải cập nhật `README.md` + `CODE_SUMMARY.md` (tiếng Anh).
- Deploy theo luật "local trước, CF sau": commit + build local + verify, **chờ lệnh
  chủ máy rồi mới `wrangler deploy` / restart bridge**. Gộp các FIX bridge chung
  1 lần restart (mỗi restart bridge = 1 lần tạo tunnel mới, đốt hạn mức 429).
- Chạy test trước khi commit: `node --test <FILE>` (truyền ĐÚNG file, không truyền
  thư mục — `node --test <dir>` fail trên máy này).

### Implementation status (added 2026-10-04 — the code is the source of truth, not the original plan below)

| FIX | Code | Tests | Commit | Deployed? |
|---|---|---|---|---|
| FIX-1 | done — `bridge/src/routes/pairing.js` | done — `bridge/test/pairing-routes.test.js` | committed (in `main`) | README (2026-10-04 pass) records it **deployed 2026-10-05** |
| FIX-2 | done — `bridge/src/static.js`, `worker/src/index.js`, `web/public/_headers` | done — `bridge/test/static-headers.test.js` | committed: `6c82d1b`, `d2c75f5` | recorded **deployed 2026-10-05** |
| FIX-3 | done — `worker/src/index.js` | done — FIX-3 cases in `worker/test/relay.test.mjs` | committed: `d2c75f5` | recorded **deployed 2026-10-05** |
| FIX-4 | done — both B and C in `worker/src/index.js` | done — FIX-4 cases in `worker/test/relay.test.mjs` | committed: `d2c75f5` | recorded **deployed 2026-10-05**; `ALLOW_ROOM_CREATE` stays an owner decision |

_Status refreshed 2026-10-08 from git log and the code: every FIX is committed. "Deployed" is taken from `docs/HISTORY.md` (the 05/10 note) — it cannot be re-verified from the repo, so confirm with `wrangler deployments list` before relying on it. The "working tree" and "stale `web/dist/_headers`" notes that used to follow this table were true only on 2026-10-04; `web/dist` is gitignored and must simply be rebuilt before every deploy._

---

## FIX-1 — Ngừng trả master token cho device key (mức: VỪA — **ĐÃ LÀM, commit 8020ef1**)

### Hiện trạng & bằng chứng

`GET /api/pairing-code` (bridge/src/routes/pairing.js, `pairingCode()` nay ở dòng
79-108) trả về response có
kèm `masterUrl` + `masterQr` — hai field này nhúng **master token**
`config.mobileToken` (loại `owm_...`, vĩnh viễn) vào URL `.../#t=<token>`.

Cổng khóa (bridge/src/app.js:73-76) chấp nhận **hai loại chìa** cho route này:

- master token → `device` = `null`
- device key `owm_...` (do `/api/pair` hoặc `/api/pair/tenant` cấp, **thu hồi
  được** qua `DELETE /api/devices/:id`) → `device` ≠ `null`

→ Mọi điện thoại đã ghép (kể cả thiết bị sắp bị gỡ) gọi
`GET /api/pairing-code` là nhận được master token trong thân response.
Web UI chủ đích KHÔNG vẽ 2 field đó (web/src/pages/settings.jsx:622) nhưng
token vẫn đi qua mạng về điện thoại.

### Vì sao nghiêm trọng

Mô hình bảo mật của dự án là "mất điện thoại → gỡ device key của nó là sạch".
Lỗ hổng này vô hiệu cơ chế đó: kẻ cầm device key (chỉ cần GỌI API MỘT LẦN trước
khi bị gỡ) đã có master token — không thể thu hồi từ điện thoại, không thể xoay
trừ khi sửa tay `config.json` trên máy rồi ghép lại toàn bộ thiết bị.

### Thiết kế sửa

**Nguyên tắc: response chỉ chứa master khi caller là master.**

1. `bridge/src/routes/pairing.js` — hàm `pairingCode` nhận thêm `device` từ
   handler args (app.js đã truyền sẵn: `route.handle({ req, res, url, pathname,
   device, ctx })`):

   ```js
   function pairingCode({ res, device }) {
     const { config } = ctx;
     const isMaster = !device; // app.js: device !== null ⟺ device key
     // ...
     const payload = {
       ok: true,
       code,
       codeFormatted: /* như cũ */,
       secondsLeft: ctx.pairing.codeSecondsLeft(),
       baseUrl: ctx.getBaseUrl(),
       tenant: config.lookupTenant || null,
       pairUrl,
       qr,
     };
     if (isMaster) {
       const masterUrl = `${ctx.getBaseUrl()}/#t=${config.mobileToken}${ctx.tenantHashSuffix()}`;
       let masterQr = "";
       qrcode.generate(masterUrl, { small: true }, (s) => { masterQr = s; });
       payload.masterUrl = masterUrl;
       payload.masterQr = masterQr;
     }
     sendJson(res, 200, payload);
   }
   ```

2. Khi caller là device: **bỏ hẳn 2 field** (không trả `""`) — dễ test, dễ thấy
   bằng mắt khi soi network tab.

3. Cập nhật doc-comment ở `web/src/api.js:289-291` (payload giờ có điều kiện)
   và comment gốc trong `routes/pairing.js`. Không đổi logic web.

### Tương thích các consumer (đã kiểm tra code)

| Consumer | Chìa dùng | Sau fix |
|---|---|---|
| GUI desktop `FetchLiveCode` (OpenPocket.cs:1843) | `Bearer <mobileToken>` từ config máy (master) | Vẫn nhận đủ masterUrl/masterQr — không đổi |
| CLI `openpocket code` (bin/openpocket.js:347-348) | `Bearer <config.mobileToken>` (master) | Không vỡ; CLI còn tự build QR master từ config (dòng 393) nên không phụ thuộc API |
| Web Settings (api.js:294 `authHeaders()`) | device key | Nhận response KHÔNG có master — UI vốn không vẽ 2 field đó |
| `?_t=` legacy (auth.js:50-53) | master token trên query | Vẫn tính master (`isTokenAuthorized` pass, `device` = null) → vẫn có master field. Đúng — đó là master thật |

### Test

Thêm vào `bridge/test/` (file mới `pairing-routes.test.js` hoặc ghép vào file
có sẵn theo pattern createApp + req/res giả mà app.js doc mô tả):

1. Bearer master token → response CÓ `masterUrl` chứa `config.mobileToken`.
2. Device key (mint qua `PairingService.mintDevice()` thật) → response KHÔNG
   có key `masterUrl`/`masterQr`, vẫn đủ `code`, `pairUrl`, `qr`, `secondsLeft`.
3. (regression) Không token → 401 như cũ.

Verify tay sau restart bridge:

```bash
curl -s http://127.0.0.1:8788/api/pairing-code -H "Authorization: Bearer <master>" | grep -o masterUrl
curl -s http://127.0.0.1:8788/api/pairing-code -H "Authorization: Bearer <owd_của_điện_thoại>"   # không có masterUrl
```

---

## FIX-2 — Gắn CSP/security headers cho static do bridge phục vụ (mức: VỪA — **ĐÃ LÀM, chưa commit**)

### Hiện trạng & bằng chứng

Web app có 2 cửa vào:

- **Cửa worker** (Cloudflare): `worker/src/index.js:193-217` (`CSP` +
  `withSecurityHeaders()`) gắn CSP + trả mọi static qua `withSecurityHeaders()` —
  có giáp.
- **Cửa tunnel** (`*.trycloudflare.com` hoặc `publicUrl` tự host): bridge tự
  phục vụ static qua `bridge/src/static.js` (nay `SECURITY_HEADERS` ở dòng 38, gắn
  vào `writeHead(200, …)` ở dòng 125-133) — **không có bất kỳ header
  bảo mật nào** (đã curl thử live: không CSP, không nosniff, không frame-guard).

Hệ quả: tấm khiên "dù lọt XSS thì script động cũng không chạy được, không với
được token trong localStorage" (mục đích của CSP như comment worker ghi) chỉ
tồn tại trên 1 trong 2 cánh cửa. Cửa tunnel chính là cửa dùng khi máy chưa vào
phòng (QR trỏ thẳng tunnel).

### Thiết kế sửa

1. `bridge/src/static.js` — thêm hằng số header, gắn vào `writeHead(200, ...)`
   của static handler (chỉ cần nhánh 200; nhánh lỗi trả body không phải HTML
   của app nên không bắt buộc):

   ```js
   // PHẢI giữ nguyên chuỗi CSP với worker/src/index.js:187-198 và
   // web/public/_headers — 3 bản cùng một nội dung, đổi một chỗ là đổi cả ba.
   const SECURITY_HEADERS = {
     "content-security-policy": [
       "default-src 'self'",
       "script-src 'self'",
       "style-src 'self' 'unsafe-inline'",
       "img-src 'self' data: blob:",
       "connect-src 'self'",
       "manifest-src 'self'",
       "object-src 'none'",
       "base-uri 'self'",
       "form-action 'none'",
       "frame-ancestors 'none'",
     ].join("; "),
     "x-content-type-options": "nosniff",
     "referrer-policy": "no-referrer",
   };
   ```

2. Đồng bộ thêm ở 2 cửa còn lại (cùng commit):
   - `worker/src/index.js` `withSecurityHeaders()`: thêm `x-content-type-options:
     nosniff` + `referrer-policy: no-referrer` (CSP đã có, giữ nguyên).
   - `web/public/_headers`: thêm 2 dòng tương ứng dưới dòng CSP có sẵn.

   `referrer-policy: no-referrer` an toàn cho app: mọi link ngoài đã
   `rel="noreferrer noopener"` từ markdown.js, link nội bộ là hash-route cùng
   origin không cần referrer.

### Test & verify

- Unit: không bắt buộc (header tĩnh). Nếu muốn: test `handleStatic` bằng
  req/res giả, assert `res.writeHead` nhận `content-security-policy` chứa
  `script-src 'self'`.
- Verify tay sau restart bridge:

```bash
curl -s -D - -o /dev/null http://127.0.0.1:8788/ | grep -i "content-security\|nosniff\|referrer"
# kỳ vọng: 3 dòng header
```

- Sau deploy worker: same check trên URL worker.

---

## FIX-3 — Rate-limit `/api/pair` theo IP ở worker (mức: NHỎ — **ĐÃ LÀM, chưa commit**)

### Hiện trạng & bằng chứng

- Worker chỉ rate-limit 2 cửa: `/api/pair/tenant` (10/phút/IP) và
  `/api/tenant/create` (5/phút/IP) — worker/src/index.js:247, 277.
  **`POST /api/pair` thì không**, relay thẳng.
- Bridge có `pairLimiter` 10/phút nhưng đếm theo `req.socket.remoteAddress`
  (routes/pairing.js:12) — mọi request từ internet đi qua cloudflared đều mang
  IP `127.0.0.1` → bucket 10/phút là bucket **CHUNG cả thế giới**.

Hệ quả kép:

- Dò mã ghép vẫn an toàn (8 ký tự ngẫu nhiên + cap chung 10/phút) — không mất
  gì về brute-force.
- Nhưng người lạ biết tên phòng (tên phòng nằm trong mọi link QR) có thể nhét
  đầy bucket → **chủ máy không ghép được thiết bị mới** trong lúc bị spam (DoS
  phiền, không lộ gì).

### Vì sao sửa ở worker, không sửa ở bridge

Tin header IP tại bridge là sai: relay của worker forward header client GỬI
nguyên vẹn (trừ host) — kẻ lạ tự đặt `x-forwarded-for` khác mỗi lần là vượt
rate limit. Cloudflared cũng chỉ thấy IP egress của worker (chung cho mọi
điện thoại), không tách được từng người. **IP đáng tin duy nhất là
`cf-connecting-ip` mà worker thấy** — nên chặn ở đó.

### Thiết kế sửa

`worker/src/index.js`, trong nhánh `/api/*`, sau khi tách được `tenant` và
TRƯỚC khi relay (đặt cạnh khối `tenant_required` hiện có; **đã nằm ở dòng 341-345**,
ngay trên nhánh `tenant_required`):

```js
// /api/pair qua relay: mọi tunnel client đều là 127.0.0.1 với bridge nên
// bucket bridge là bucket CHUNG — chặn theo IP thật phải nằm ở worker.
if (url.pathname === "/api/pair" && request.method === "POST" && tenant) {
  if (await rateLimited(request, "pair", 10)) {
    return json({ code: "rate_limited", message: "Too many pairing attempts - wait about 1 minute and try again." }, 429);
  }
}
```

- Cùng limit 10/phút/IP như pair-tenant (dùng chung `rateLimited()` có sẵn).
- Bridge giữ nguyên pairLimiter như mũ sắt thứ hai (vẫn chặn direct-tunnel).
- Test: thêm vào `worker/test/relay.test.mjs` — request thứ 11 trong cùng phút
  cùng IP → 429 JSON `rate_limited`; IP khác không bị ảnh hưởng.

---

## FIX-4 — `/api/tenant/create`: spam + race (mức: NHỎ — **ĐÃ LÀM, phương án B+C, chưa commit**)

### Hiện trạng & bằng chứng (worker/src/index.js:269-323)

1. **Cửa mở công khai**: ai biết URL worker cũng tự tạo phòng được (by design,
   self-serve). Trần 50 phòng + 5/phút/IP — nhưng một IP lấp hết 50 tên trong
   ~10 phút → chủ máy và người dùng thật không tạo phòng nữa (DoS vĩnh viễn
   until dọn KV tay).
2. **Race check-then-put**: hai create cùng tên cùng lúc đều thấy `existing =
   null` → cùng `put`, ai ghi sau thắng. Kẻ lạ đua đúng khoảnh khắc máy chủ
   provisioning có thể ghi đè secret → cướp TÊN phòng.
   Giới hạn thực tế của cướp tên: secret lệch → bridge của chủ máy đăng ký
   401, điện thoại chủ máy đăng nhập sai pass — **không bị trỏ sang máy lạ**,
   chỉ kẹt "sai phòng/mật khẩu" khó hiểu cho đến khi tạo lại. Không lộ dữ liệu.

### Các phương án

| Phương án | Chi phí | Hiệu quả | Khuyến nghị |
|---|---|---|---|
| A. Giữ nguyên, chỉ ghi nhận rủi ro | 0 | — | ✅ nếu máy nhà đã có phòng ổn định (tên đã bị chiếm chỗ rồi thì spam không cướp được nữa — create với tên TỒN TẠI luôn đòi đúng secret) |
| B. Var môi trường khóa cửa: `ALLOW_ROOM_CREATE=0` → route trả 403 | ~10 dòng | Chặn hoàn toàn spam + race khi không cần self-serve | ✅ làm kèm — mặc định mở (`1`) để không đổi hành vi ai cả; ngày nào cần khóa thì set var + deploy |
| C. Read-after-write: sau `put` đọc lại, secret khác mình vừa ghi → trả 409 "taken" để GUI báo rõ thay vì im lặng | ~5 dòng | Không chặn race, chỉ phát hiện + thông báo đúng thay vì lỗi 401 mơ hồ sau này | ✅ làm kèm B (rẻ, dễ test) |
| D. Durable Objects / CAS | phức tạp, quá cần | — | ❌ không đáng |

Ghi chú: nếu chọn B, GUI provisioning (OpenPocket.cs) cần hint rõ khi nhận
403 (đóng cửa) thay vì retry mù — **còn nợ, xem "Còn nợ sau khi vá" bên dưới**.

### Đã làm gì (B + C, 2026-10-04)

Cả hai phương án **B và C đều đã nằm trong `worker/src/index.js`** (đây là trạng
thái code thật, không phải một quyết định mới của chủ máy) và đã có test:

- **B — cổng khóa (dòng 270-276).** `env.ALLOW_ROOM_CREATE === "0"` → 403
  `{code: "room_create_disabled"}` **trước khi đọc body** (nên flood mù cũng chưa
  chạm KV). Không đặt var, hoặc đặt `"1"` → mở y như cũ, không ai đổi hành vi.
  Phòng đã có vẫn đăng nhập bình thường (`/api/pair/tenant` là route khác).
- **C — read-after-write (dòng 318-321).** Sau `put`, đọc lại `tenant:${user}` và
  so `sameSecret(secret, saved.secret)`; lệch → 409 `{code: "taken"}`, **không**
  trả `created`. Đọc hụt (`null`) thì vẫn 200 — không kêu "taken" oan.
- Test: 4 ca `FIX-4` trong `worker/test/relay.test.mjs` (403 không đụng KV · race →
  409 · read hụt → 200 · không đặt var → vẫn tạo).

### Còn nợ sau khi vá

- **GUI provisioning chưa đọc được mã 403** (câu ghi chú ở trên chưa ai làm):
  `desktop/src/OpenPocket.cs:854` là `req.GetResponse()` — 403 ném `WebException`,
  rơi vào catch ở dòng 871 với `provisionError = ex.Message` (text thô kiểu
  "The remote server returned an error: (403) Forbidden"), nên mã
  `room_create_disabled` **không bao giờ hiện ra GUI**. Hệ quả: đặt
  `ALLOW_ROOM_CREATE=0` làm máy mới không provisioning được phòng.
- **Deploy + đặt biến**: chưa `wrangler deploy`, chưa đặt `ALLOW_ROOM_CREATE`.
  Đặt `=0` là quyết định riêng của chủ máy, mặc định vẫn để mở.

---

## Không sửa trong đợt này (rủi ro đã chấp nhận — ghi sổ để khỏi điều tra lại)

> **Cập nhật 2026-10-05:** cả ba mục dưới đây ĐÃ được xử lý trong pass
> "remaining-risk closure" cùng ngày (8 nhóm vá song song, mutation-verified,
> QA 3 lens) — xem README mục "Remaining-risk closure pass (2026-10-05)".
> (1) `?_t=` đã BỊ XOÁ khỏi `bridge/src/auth.js` (chủ nhà chốt: chỉ mình chủ
> nhà chạy app, chấp nhận PWA cũ phải tải lại — sw v55 ép bundle mới).
> (3) cloudflared giờ tải bản GHIM `2026.9.3` + verify SHA256 (hash lấy từ
> asset digest của GitHub API) trước khi ghi đĩa và mỗi lần start.
> (2) plaintext secret: KV worker KHÔNG còn giữ plaintext (lưu `secretHash`,
> record legacy tự nâng cấp lúc đăng nhập thành công); `config.json` giữ
> plaintext CÓ CHỦ ĐÍCH (GUI C# đọc trực tiếp) nhưng được siết ACL sau mỗi
> lần ghi và mọi đường log đã redact token.

1. **`?_t=` token trên query** (bridge/src/auth.js:46-55) — đường cũ cho PWA đã
   cài còn cache bundle cũ; chủ đích giữ. Token có thể nằm trong history trình
   duyệt. Điều kiện sunset: xóa khi bridge phát hành bản đủ mới + 1 nhịp chuyển
   đổi (quyết định riêng, không gấp). — **ĐÃ ĐÓNG 05/10, xem ghi chú trên.**
2. **Secret plaintext**: tenant secret trong KV worker (chủ worker đọc được);
   `mobileToken`/`lookupSecret` trong `%APPDATA%\openwork-bridge\config.json`
   (ACL theo user, chuẩn app local). Băm được nhưng đánh đổi khả năng thu hồi/
   đối chiếu — không thay đổi. — **KV ĐÃ HASH 05/10; config.json giữ plaintext
   có chủ đích + ACL siết + log redact.**
3. **cloudflared tải từ GitHub releases không verify chữ ký**
   (bridge/src/tunnel.js:19, 78) — tin HTTPS + GitHub chính chủ. — **ĐÃ GHIM
   PHIÊN BẢN + VERIFY SHA256 05/10.**

## Check-list triển khai (cập nhật 2026-10-04)

1. [x] FIX-1 bridge + test → commit `bridge: stop returning the master token to
   device keys` (đã có: `8020ef1`)
2. [ ] FIX-2 static.js + worker headers + `_headers` + test → commit
   `security: armor the tunnel-served web app too` — **code + test xong
   (`bridge/test/static-headers.test.js` 3 pass), còn nằm trong working tree**
3. [ ] FIX-3 worker + test relay → commit `worker: rate-limit pair attempts per
   IP` — **code + test xong (17 pass), còn nằm trong working tree**
4. [ ] FIX-4 phương án B+C → commit riêng — **code + test xong, còn nằm trong
   working tree**. Lưu ý khi tách: FIX-3 + FIX-4 cùng nằm trong MỘT file
   `worker/src/index.js`, nên phải chia commit bằng `git add -p`, không
   `git add` cả file.
5. [ ] Mỗi commit: cập nhật README.md + CODE_SUMMARY.md (tiếng Anh) cùng commit —
   đã cập nhật trong working tree, chỉ còn áp dụng khi tách commit
6. [ ] Build web (`npm --prefix web run build`) — **BẮT BUỘC trước khi deploy**:
   build mới nhất chạy lúc 21:12 ngày 04/10, **trước** khi sửa
   `web/public/_headers`, nên `web/dist/_headers` còn thiếu `nosniff` +
   `referrer-policy`; cả worker (assets `../web/dist`) và bridge đều đọc thư mục
   này. Chạy test bridge & web cùng lúc.
7. [ ] Restart bridge MỘT LẦN cho FIX-1+2 (nhớ: restart = xin tunnel mới, giờng gian
   giãn với lần 429 gần nhất nếu có)
8. [ ] Deploy worker MỘT LẦN cho FIX-2+3+4: `cd worker && npx wrangler deploy`
   (sau bước 6). Đặt `ALLOW_ROOM_CREATE=0` là việc riêng, chỉ làm khi chủ máy
   chốt — và nhớ nó làm GUI provisioning hỏng (xem FIX-4 "Còn nợ").
9. [ ] Verify live: curl headers trên localhost + URL worker; curl pairing-code
       với device key (không còn masterUrl) và master token (vẫn đủ)

> Phạm vi: đợt làm gọn UI ở `web/src/styles.css`, `web/src/pages/home.jsx`,
> `web/src/pages/sessions.jsx` (mục đầu CODE_SUMMARY.md) **không thuộc** đợt vá
> bảo mật này — tách commit riêng, không gộp vào 4 FIX trên.
