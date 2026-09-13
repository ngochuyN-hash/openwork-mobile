import { useEffect, useState } from "preact/hooks";
import { setToken, apiState, apiPair, apiPairTenant, pairingCodeFromHash, inviteFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// Mở app = duy nhất ô Đăng nhập (user + pass + tên thiết bị + nút) — không
// placeholder, không chữ giải thích. Hai cách kết nối còn lại (mã ghép 1 lần
// XXXX-XXXX in trên terminal bridge, và dán token owm_/owd_ dài hạn) nằm sau
// nút "Cách kết nối khác", bấm mới lộ hàng tab. Link mời #i= và link ghép #p=
// vẫn tự chạy khi mở, không cần đụng tab nào.
export function PairingScreen({ onPaired }) {
  const [tab, setTab] = useState("login");
  const [showAlt, setShowAlt] = useState(false);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [code, setCode] = useState("");
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
    const token = code.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    setStatus("Đang kiểm tra token…");
    setToken(token);
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
  // tự đăng nhập luôn. Link mời hỏng/máy chưa join → màn Đăng nhập vẫn được
  // điền sẵn user/pass, bấm lại một phát là xong.
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
      </div>

      <div class="card">
        {showAlt && (
          <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
            <button
              class={`btn small ${tab === "login" ? "" : "ghost"}`}
              onClick={() => {
                setTab("login");
                setError("");
              }}
            >
              Đăng nhập
            </button>
            <button
              class={`btn small ${tab === "pair" ? "" : "ghost"}`}
              onClick={() => {
                setTab("pair");
                setCode("");
                setError("");
              }}
            >
              Ghép thiết bị
            </button>
            <button
              class={`btn small ${tab === "token" ? "" : "ghost"}`}
              onClick={() => {
                setTab("token");
                setCode("");
                setError("");
              }}
            >
              Nhập token
            </button>
          </div>
        )}

        {tab === "login" ? (
          <>
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
            {!showAlt && (
              <p class="pair-hint" style="margin-top:14px">
                <button
                  class="btn small ghost"
                  onClick={() => {
                    setShowAlt(true);
                    setError("");
                  }}
                >
                  Cách kết nối khác: mã ghép · token
                </button>
              </p>
            )}
          </>
        ) : tab === "pair" ? (
          <>
            <label class="field" for="pair-code">
              Mã ghép 8 ký tự (in trên terminal bridge, sống 30 phút — hoặc quét QR trên đó)
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
            <label class="field" for="pair-label">Tên thiết bị này (tùy chọn)</label>
            <input
              id="pair-label"
              type="text"
              value={label}
              onInput={(e) => setLabel(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && submitPair()}
            />
            <div class="sheet-actions">
              <button class="btn" disabled={busy || !code.trim()} onClick={submitPair}>
                {busy ? status || "Đang ghép…" : "Ghép thiết bị"}
              </button>
            </div>
            {status && !error && busy && <p class="pair-hint">{status}</p>}
            {error && <Banner kind="err">{error}</Banner>}
          </>
        ) : (
          <>
            <label class="field" for="token-code">
              Token dài hạn của bạn (master từ QR master trên máy, hoặc khóa của thiết bị cũ)
            </label>
            <input
              id="token-code"
              type="text"
              spellcheck={false}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && connectWithToken()}
            />
            <div class="sheet-actions">
              <button class="btn" disabled={busy || !code.trim()} onClick={connectWithToken}>
                {busy ? status || "Đang kiểm tra…" : "Kết nối"}
              </button>
            </div>
            {status && !error && busy && <p class="pair-hint">{status}</p>}
            {error && <Banner kind="err">{error}</Banner>}
          </>
        )}
      </div>
    </div>
  );
}
