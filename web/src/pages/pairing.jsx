import { useEffect, useState } from "preact/hooks";
import { setToken, setTenant, apiPair, pairingCodeFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";

// Màn vào app kiểu 9remote với 2 đường: HÀNG MÃ GHÉP 8 ký tự (tạm thời, sống
// 30 phút, in trong OpenPocket) và HÀNG KHÓA VĨNH VIỄN (dán link master hoặc
// khóa full copy từ OpenPocket — máy đã ghép từ trước thì khỏi đợi mã mới).
// Không tài khoản, không mật khẩu. Link QR #p= (và master #t=) tự vào trước
// khi tới màn này; muốn gõ tay thì mở OpenPocket → "Xem mã ghép".
export function PairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function pairWithCode(codeValue) {
    setBusy(true);
    setError("");
    setStatus("Đang ghép với máy tính…");
    try {
      const { token } = await apiPair(codeValue, "");
      setToken(token);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    const value = code.trim().toUpperCase().replace(/[\s-]/g, "");
    if (value) pairWithCode(value);
  }

  // Bóc link master dạng ...#t=<khóa>&m=<phòng> (nút "Sao chép link master")
  // hoặc khóa trần owd_/owt_ không kèm phòng.
  function parsePermanentKey(raw) {
    const text = String(raw ?? "").trim();
    const fromLink = /#t=([^&\s]+)(?:&m=([^&\s]+))?/.exec(text);
    if (fromLink?.[1]) {
      return {
        token: decodeURIComponent(fromLink[1]),
        tenant: fromLink[2] ? decodeURIComponent(fromLink[2]).trim().toLowerCase() : "",
      };
    }
    const bare = text.replace(/\s+/g, "");
    if (/^(owm|owd|owt)_[0-9a-f]{8,}$/i.test(bare)) return { token: bare, tenant: "" };
    return null;
  }

  async function loginWithKey() {
    const parsed = parsePermanentKey(key);
    if (!parsed) {
      setError("Khóa không đúng dạng — dán link master hoặc khóa full (owm_/owd_…) copy từ OpenPocket.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("Đang mở khóa…");
    try {
      if (!parsed.tenant) {
        // Khóa trần không biết phòng: /api/state không mã phòng sẽ được worker
        // dò qua các máy còn sống; máy nhận khóa trả edge.tenant của chính nó.
        const res = await fetch("/api/state", { headers: { authorization: `Bearer ${parsed.token}` } });
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.message ?? `HTTP ${res.status}`);
        parsed.tenant = String(payload?.edge?.tenant ?? "").trim().toLowerCase();
        if (!parsed.tenant) throw new Error("Máy này chưa có phòng — dùng mã ghép 8 ký tự.");
      }
      setToken(parsed.token);
      setTenant(parsed.tenant);
      onPaired();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  useEffect(() => {
    const fromHash = pairingCodeFromHash();
    if (fromHash) pairWithCode(fromHash);
  }, []);

  return (
    <div class="view no-nav pair-view">
      <div class="pair-hero">
        <OpenWorkMark className="pair-logo" />
        <h2>OpenWork Mobile</h2>
        <div class="pair-sub">OpenWork in your pocket</div>
      </div>

      <div class="card">
        <label class="field" for="pair-code">
          Mã ghép 8 ký tự (hiện trong OpenPocket trên máy tính)
        </label>
        <input
          id="pair-code"
          class="pair-code-input"
          type="text"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck={false}
          value={code}
          onInput={(e) => setCode(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div class="sheet-actions">
          <button class="btn pair-btn" disabled={busy || !code.trim()} onClick={submit}>
            {busy ? status || "Đang ghép…" : "Vào"}
          </button>
        </div>

        <div class="pair-or"><span>hoặc</span></div>

        <label class="field" for="pair-key">
          Khóa vĩnh viễn (dán link master / khóa full copy từ OpenPocket)
        </label>
        <input
          id="pair-key"
          class="pair-key-input"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={key}
          onInput={(e) => setKey(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && loginWithKey()}
        />
        <div class="sheet-actions">
          <button class="btn pair-btn" disabled={busy || !key.trim()} onClick={loginWithKey}>
            {busy ? status || "Đang mở khóa…" : "Vào bằng khóa"}
          </button>
        </div>

        {busy && status && !error && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
        <p class="pair-hint">
          Không có cả hai? Bấm "Xem mã ghép (QR)" trong OpenPocket trên máy tính —
          quét QR bằng camera cũng vào được, không cần gõ.
        </p>
      </div>
    </div>
  );
}
