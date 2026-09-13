import { useEffect, useState } from "preact/hooks";
import { setToken, apiState, apiPair, apiPairTenant, pairingCodeFromHash, inviteFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// MỘT thẻ duy nhất chia 3 dòng (yêu cầu chủ máy: không tab, không ẩn):
//   1. Đăng nhập — user/pass do chủ worker cấp (apiPairTenant)
//   2. Ghép thiết bị — mã 1 lần 8 ký tự in trên terminal bridge (apiPair)
//   3. Nhập token — dán thẳng owm_/owd_ dài hạn
// Điền khớp DUY NHẤT một dòng là vào được, ba nút độc lập nhau. Không
// placeholder, không chữ giải thích thừa — label trên ô nhập nói đủ. Tên thiết
// bị (tùy chọn) nằm ở dòng 1 nhưng dùng chung: ghép bằng mã cũng gửi theo.
// Link mời #i= và link ghép #p= vẫn tự chạy khi mở, không cần đụng form.
export function PairingScreen({ onPaired }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
  const [token, setTokenValue] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function pairWithCode(codeValue, labelValue) {
    setBusy(true);
    setError("");
    setStatus("Đang ghép với bridge…");
    try {
      const { token } = await apiPair(codeValue, labelValue);
      setToken(token);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Đăng nhập phòng (multi-tenant) — khóa + tên máy được api.js tự lưu
  async function loginWithTenant(userValue, passValue, labelValue) {
    setBusy(true);
    setError("");
    setStatus("Đang đăng nhập…");
    try {
      const { machineName } = await apiPairTenant(userValue, passValue, labelValue);
      setStatus("");
      setError("");
      console.log(`[pairing] đã vào máy: ${machineName}`);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Dự phòng: dán trực tiếp token dài (owm_/owd_)
  async function connectWithToken() {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    setStatus("Đang kiểm tra token…");
    setToken(value);
    try {
      await apiState();
      onPaired();
    } catch {
      localStorage.removeItem("owm_token");
      setStatus("");
      setError("Token không đúng hoặc bridge chưa chạy.");
    } finally {
      setBusy(false);
    }
  }

  function submitPair() {
    const value = code.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!value) return;
    pairWithCode(value, label);
  }

  function submitLogin() {
    if (!user.trim() || !pass) return;
    loginWithTenant(user, pass, label);
  }

  // Tự chạy khi mở link: #p=MÃ(&m=PHÒNG) → ghép; #i=USER:SECRET (link mời) →
  // tự đăng nhập luôn. Link mời hỏng/máy chưa join → form vẫn được điền sẵn
  // user/pass, bấm lại một phát là xong.
  useEffect(() => {
    const fromHash = pairingCodeFromHash();
    if (fromHash) {
      pairWithCode(fromHash, "");
      return;
    }
    const invite = inviteFromHash();
    if (invite) {
      setUser(invite.user);
      setPass(invite.secret);
      loginWithTenant(invite.user, invite.secret, "");
    }
  }, []);

  const divider = (
    <hr style="border:none;border-top:1px solid var(--border);margin:18px 0 0" />
  );
  const rowTitle = (text) => (
    <div style="font-weight:600;font-size:13.5px;margin:14px 0 0">{text}</div>
  );

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <OpenWorkMark className="pair-logo" />
        <h2 style="margin:0;letter-spacing:-0.01em">OpenWork Mobile</h2>
        <div class="pair-sub">OpenWork in your pocket</div>
      </div>

      <div class="card">
        {rowTitle("Đăng nhập")}
        <label class="field" for="login-user">Tên đăng nhập</label>
        <input
          id="login-user"
          type="text"
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          value={user}
          onInput={(e) => setUser(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitLogin()}
        />
        <label class="field" for="login-pass">Mật khẩu</label>
        <input
          id="login-pass"
          type="password"
          autocomplete="current-password"
          value={pass}
          onInput={(e) => setPass(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitLogin()}
        />
        <label class="field" for="login-label">Tên thiết bị này (tùy chọn)</label>
        <input
          id="login-label"
          type="text"
          value={label}
          onInput={(e) => setLabel(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitLogin()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !user.trim() || !pass} onClick={submitLogin}>
            {busy ? status || "Đang đăng nhập…" : "Đăng nhập"}
          </button>
        </div>

        {divider}

        {rowTitle("Ghép thiết bị")}
        <label class="field" for="pair-code">
          Mã 8 ký tự in trên terminal bridge (sống 30 phút — hoặc quét QR trên đó)
        </label>
        <input
          id="pair-code"
          type="text"
          autocomplete="one-time-code"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submitPair()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !code.trim()} onClick={submitPair}>
            {busy ? status || "Đang ghép…" : "Ghép thiết bị"}
          </button>
        </div>

        {divider}

        {rowTitle("Nhập token")}
        <label class="field" for="token-code">
          Token dài hạn owm_ / owd_ (master từ QR master trên máy, hoặc khóa thiết bị cũ)
        </label>
        <input
          id="token-code"
          type="text"
          spellcheck={false}
          value={token}
          onInput={(e) => setTokenValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && connectWithToken()}
        />
        <div class="sheet-actions">
          <button class="btn" disabled={busy || !token.trim()} onClick={connectWithToken}>
            {busy ? status || "Đang kiểm tra…" : "Kết nối"}
          </button>
        </div>

        {status && !error && busy && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
      </div>
    </div>
  );
}
