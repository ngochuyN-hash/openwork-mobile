import { useEffect, useState } from "preact/hooks";
import { setToken, apiPair, apiPairTenant, pairingCodeFromHash, inviteFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// Màn mở app = duy nhất ô Đăng nhập (user + pass + tên thiết bị + nút) —
// không placeholder, không chữ giải thích thừa. Ghép thiết bị (mã 1 lần) và
// nhập token owm_/owd_ KHÔNG nằm ở đây nữa: đã dời vào Settings sau khi đăng
// nhập (yêu cầu chủ máy — tường đăng nhập phải sạch). Hai đường tự động vẫn
// chạy từ trước khi vào: link mời #i=user:secret tự đăng nhập, link ghép
// #p=MÃ tự ghép (QR trên terminal bridge trỏ vào link này).
export function PairingScreen({ onPaired }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // Ghép bằng mã 1 lần — chỉ còn đường tự động qua link #p= (quét QR)
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

  function submitLogin() {
    if (!user.trim() || !pass) return;
    loginWithTenant(user, pass, label);
  }

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

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <OpenWorkMark className="pair-logo" />
        <h2 style="margin:0;letter-spacing:-0.01em">OpenWork Mobile</h2>
        <div class="pair-sub">OpenWork in your pocket</div>
      </div>

      <div class="card">
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
        {status && !error && busy && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
      </div>
    </div>
  );
}
