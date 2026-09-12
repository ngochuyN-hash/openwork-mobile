import { useEffect, useState } from "preact/hooks";
import { setToken, apiState, apiPair, apiPairTenant, pairingCodeFromHash, inviteFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// 3 cách kết nối song song:
//  TAB "Đăng nhập" — multi-tenant: user+pass do chủ worker cấp, máy của BẠN
//  phải đã chạy `openpocket edge join`. Nhập 1 lần: khóa vĩnh viễn owd_ được
//  cấp + lưu luôn trên máy, mật khẩu KHÔNG lưu — lần sau mở app vào thẳng.
//  TAB "Ghép thiết bị" — nhập mã one-time 8 ký tự (XXXX-XXXX) in trên terminal
//  bridge (sống 30 phút, dùng 1 lần). Ghép xong thiết bị nhận khóa vĩnh viễn owd_.
//  TAB "Nhập token" — dành cho token dài hạn đã có (master owm_ từ QR master,
//  hoặc owd_ của thiết bị): nhập vào là vào thẳng, không cần qua mã.
export function PairingScreen({ onPaired }) {
  const [tab, setTab] = useState("login");
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
        <p class="pair-sub">Quản lý session, workspace và file của OpenWork từ điện thoại</p>
      </div>

      <div class="card">
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

        {tab === "login" ? (
          <>
            <label class="field" for="login-user">Tên đăng nhập</label>
            <input
              id="login-user"
              type="text"
              placeholder="vd: nam"
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
              placeholder="••••••••"
              autocomplete="current-password"
              value={pass}
              onInput={(e) => setPass(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && submitLogin()}
            />
            <label class="field" for="login-label">Tên thiết bị này (tùy chọn)</label>
            <input
              id="login-label"
              type="text"
              placeholder="vd: iPhone của Nam"
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
            <p class="pair-hint">
              Tài khoản do chủ máy cấp. Nhập một lần — khóa được lưu luôn trên máy này,
              mật khẩu không giữ lại; lần sau mở app là vào thẳng.
            </p>
          </>
        ) : tab === "pair" ? (
          <>
            <label class="field" for="pair-code">
              Mã ghép (in trên terminal bridge, sống 30 phút — hoặc quét QR trên đó)
            </label>
            <input
              id="pair-code"
              type="text"
              placeholder="XXXX-XXXX"
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
              placeholder="vd: iPhone của bạn"
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
            <p class="pair-hint">
              Ghép xong thiết bị này được cấp khóa vĩnh viễn — lần sau mở app là vào thẳng, không cần mã nữa.
            </p>
          </>
        ) : (
          <>
            <label class="field" for="token-code">
              Token dài hạn của bạn (master từ QR master trên máy, hoặc khóa của thiết bị cũ)
            </label>
            <input
              id="token-code"
              type="text"
              placeholder="owm_… hoặc owd_…"
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
            <p class="pair-hint">Token nhập vào có hiệu lực vĩnh viễn — dùng cho thiết bị tin cậy của bạn.</p>
          </>
        )}
      </div>

      <p class="pair-hint">Mất điện thoại / muốn bỏ quyền truy cập: vào Settings → Thiết bị đã ghép → thu hồi.</p>
    </div>
  );
}
