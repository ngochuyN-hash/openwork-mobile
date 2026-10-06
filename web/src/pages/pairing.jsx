import { useEffect, useState } from "preact/hooks";
import { setToken, setTenant, apiPair, pairingCodeFromHash } from "../api.js";
import { Banner } from "../components/ui.jsx";
import { OpenWorkMark } from "../components/logo.jsx";
import { ErrorCode, MASTER_TOKEN_HASH, TENANT_HASH_KEY, TOKEN_PREFIX_SOURCE } from "../../../shared/contract.js";

// Roomless key/QR: the worker refuses every roomless web entry with
// 400 tenant_required — the message must only name paths that still exist
// (a full link with &m=, or the room box below).
const TENANT_HINT = `Key/QR code missing room parameter — use the full pairing/master link with &${TENANT_HASH_KEY}= from your computer, or enter the room name in the Room field and try again.`;

// Màn vào app kiểu 9remote với 2 đường, mỗi hàng đúng một nhãn ngắn (owner
// call: bỏ hết chỉ dẫn dài — hàng nào mã tạm thời, hàng nào mã vĩnh viễn là
// đủ). Link QR #p= (và master #t=) tự vào trước khi tới màn này.
export function PairingScreen({ onPaired }) {
  const [code, setCode] = useState("");
  const [key, setKey] = useState("");
  const [room, setRoom] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function pairWithCode(codeValue) {
    setBusy(true);
    setError("");
    setStatus("Pairing…");
    try {
      const { token } = await apiPair(codeValue, "");
      setToken(token);
      onPaired();
    } catch (e) {
      setStatus("");
      setError(e.code === ErrorCode.TENANT_REQUIRED ? TENANT_HINT : String(e.message || e));
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
    const fromLink = new RegExp(
      `#${MASTER_TOKEN_HASH}=([^&\\s]+)(?:&${TENANT_HASH_KEY}=([^&\\s]+))?`
    ).exec(text);
    if (fromLink?.[1]) {
      return {
        token: decodeURIComponent(fromLink[1]),
        tenant: fromLink[2] ? decodeURIComponent(fromLink[2]).trim().toLowerCase() : "",
      };
    }
    const bare = text.replace(/\s+/g, "");
    if (new RegExp(`^${TOKEN_PREFIX_SOURCE}[0-9a-f]{8,}$`, "i").test(bare)) return { token: bare, tenant: "" };
    return null;
  }

  async function loginWithKey() {
    const parsed = parsePermanentKey(key);
    if (!parsed) {
      setError("Invalid key — copy master link or key from OpenPocket.");
      return;
    }
    // The room box only backfills a BARE key (no &m=): a full master link
    // already carries its room and wins over what is typed here.
    const typedRoom = room
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "");
    if (!parsed.tenant && typedRoom) parsed.tenant = typedRoom;
    setBusy(true);
    setError("");
    setStatus("Unlocking…");
    try {
      if (!parsed.tenant) {
        // Still roomless: the worker answers 400 tenant_required (it never
        // fans a roomless key out to machines) — surface that hint verbatim.
        const res = await fetch("/api/state", { headers: { authorization: `Bearer ${parsed.token}` } });
        const payload = await res.json().catch(() => null);
        if (payload?.code === ErrorCode.TENANT_REQUIRED) throw new Error(TENANT_HINT);
        if (!res.ok) throw new Error(payload?.message ?? `HTTP ${res.status}`);
        parsed.tenant = String(payload?.edge?.tenant ?? "").trim().toLowerCase();
        if (!parsed.tenant) throw new Error("This machine has no room configured — use the 8-character pairing code.");
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
        <label class="field" for="pair-code">Temporary code (8 chars)</label>
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
            {busy ? status || "Pairing…" : "Connect"}
          </button>
        </div>

        <div class="pair-or"><span>or</span></div>

        <label class="field" for="pair-key">Permanent key</label>
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
        <label class="field" for="pair-room" style="margin-top:10px">Room (if key doesn't include it)</label>
        <input
          id="pair-room"
          class="pair-key-input"
          type="text"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          value={room}
          onInput={(e) => setRoom(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && loginWithKey()}
        />
        <div class="sheet-actions">
          <button class="btn pair-btn" disabled={busy || !key.trim()} onClick={loginWithKey}>
            {busy ? status || "Unlocking…" : "Connect with key"}
          </button>
        </div>

        {busy && status && !error && <p class="pair-hint">{status}</p>}
        {error && <Banner kind="err">{error}</Banner>}
      </div>
    </div>
  );
}
