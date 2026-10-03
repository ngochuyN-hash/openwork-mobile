import { useEffect, useState } from "preact/hooks";
import {
  getTenant,
  getTenantName,
  getToken,
  removeKey,
  notifyKeysChanged,
  apiRecheck,
  apiDevices,
  apiRevokeDevice,
  apiWakeOpenWork,
  apiOpenWorkPath,
} from "../api.js";
import { useConfirm, Banner } from "../components/ui.jsx";
import { PcsIcon } from "../components/icons.jsx";
import { OpenWorkFix } from "../components/openwork-fix.jsx";
import {
  mergeCandidates,
  openworkFoundOf,
  openworkRunningOf,
  openworkStatusLabel,
} from "../lib/openwork-fix.js";
import { navigate } from "../app.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  const [checkMsg, setCheckMsg] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();
  const [devices, setDevices] = useState(null);
  const [thisDeviceLabel, setThisDeviceLabel] = useState("");

  // OpenWork desktop trên máy tính: object `openwork` từ /api/state. Sau khi bấm
  // "Chỉ đường dẫn" thành công thì bridge trả về openwork mới — giữ ở state để
  // vẽ ngay, khỏi đợi vòng poll sau.
  const [openworkOverride, setOpenworkOverride] = useState(null);
  const [savingPath, setSavingPath] = useState(false);
  const [pathMsg, setPathMsg] = useState("");
  const [pathErr, setPathErr] = useState("");
  // Bật/tắt khối chọn đường dẫn. Mặc định MỞ khi chưa tìm thấy (đó là lúc cần),
  // và người dùng bấm "Đổi đường dẫn" để mở khi đã tìm thấy.
  const [editing, setEditing] = useState(false);
  // Bridge trả `candidates` khi wake không tìm thấy exe — đổ vào chung bộ chọn.
  const [wakeCandidates, setWakeCandidates] = useState([]);

  useEffect(() => {
    apiDevices().then(setDevices).catch(() => setDevices([]));
    if (state?.thisDevice?.label) setThisDeviceLabel(state.thisDevice.label);
  }, [state?.thisDevice?.id]);

  // /api/state vừa về là sự thật mới nhất: bỏ giá trị tạm để tránh màn hình kẹt ở
  // kết quả cũ mãi (ví dụ vừa cài lại OpenWork ở chỗ khác, poll thấy path mới
  // nhưng UI vẫn vẽ path cũ vì override đè lên).
  useEffect(() => {
    setOpenworkOverride(null);
  }, [state?.openwork]);

  async function revoke(device) {
    askConfirm({
      title: "Thu hồi thiết bị?",
      body: `"${device.label}" sẽ mất quyền truy cập vĩnh viễn (phải ghép lại bằng mã mới).`,
      confirmLabel: "Thu hồi",
      onConfirm: async () => {
        try {
          const { devices } = await apiRevokeDevice(device.id);
          setDevices(devices);
        } catch {
          /* bỏ qua - tải lại danh sách */
        }
      },
    });
  }

  async function recheck() {
    setBusy(true);
    setCheckMsg("");
    try {
      await apiRecheck();
      onRecheck();
    } catch (e) {
      // Tunnel chết / 401 phải báo rõ, không im lặng trả nút về trạng thái cũ.
      setCheckMsg(
        e.message === "UNPAIRED"
          ? "Chìa hết hiệu lực (401) — máy đã thu hồi khóa này, hãy ghép lại."
          : `Kiểm tra lỗi: ${String(e.message || e)}`
      );
    } finally {
      setBusy(false);
    }
  }

  async function wake() {
    setWaking(true);
    setWakeMsg("");
    try {
      const result = await apiWakeOpenWork();
      if (result?.alreadyRunning) {
        await apiRecheck();
        onRecheck();
      } else {
        setWakeMsg("Đã gửi lệnh mở OpenWork — đợi ~20s rồi bấm Kiểm tra lại.");
      }
    } catch (e) {
      setWakeMsg(String(e.message || e));
      // Không tìm thấy exe: bridge kèm sẵn danh sách đường dẫn nghi vấn — đừng bỏ
      // qua, đưa vào đúng bộ chọn bên dưới để người dùng chỉ được luôn.
      // CỘNG DỒN, không thay thế: bấm "Bật OpenWork" lần thứ hai trả về một danh
      // sách khác, `setWakeCandidates(e.candidates)` sẽ XOÁ mất ứng viên bridge
      // gửi ở lần trước. `mergeCandidates(prev, ...)` giữ cả hai và bỏ trùng —
      // cùng cách banner ở app.jsx làm.
      if (e?.candidates?.length) {
        setWakeCandidates((prev) => mergeCandidates(prev, e.candidates));
      }
    } finally {
      setWaking(false);
    }
  }

  /** Gửi 1 đường dẫn exe lên bridge. Thành công thì vẽ lại từ `openwork` bridge
   * trả về; thất bại thì hiện nguyên văn message tiếng Việt của bridge.
   *
   * PHẢI reject khi lưu thất bại (contract của <OpenWorkFix>): component giữ
   * nguyên đường dẫn trong ô gõ ở nhánh reject. Nuốt lỗi rồi resolve sẽ xoá
   * sạch ô gõ dù bridge đã từ chối — người dùng phải gõ lại từ đầu.
   *
   * "Thất bại" gồm HAI trường hợp, không chỉ lỗi HTTP:
   *   1. `apiOpenWorkPath` ném (bridge từ chối / mạng hỏng);
   *   2. HTTP 200 nhưng `openwork.found` false — bridge đã lưu đường dẫn nhưng
   *      vẫn không thấy file. Trường hợp này CÓ THẬT: route trả 200 kèm
   *      `openworkStateInfo()` mà `describeOpenWorkInstall` nuốt lỗi khi đọc
   *      version ném (bridge/src/openwork-version.js) → `{found:false}` dù file
   *      có thật. Cùng cách `chooseExePath` ở app.jsx xử lý. */
  async function choosePath(path) {
    const target = String(path ?? "").trim();
    if (!target) return;
    setSavingPath(true);
    setPathMsg("");
    setPathErr("");
    let payload;
    try {
      payload = await apiOpenWorkPath(target);
    } catch (e) {
      setPathErr(String(e?.message || e));
      throw e; // xem JSDoc — không nuốt, component cần rejection để giữ ô gõ
    } finally {
      setSavingPath(false);
    }
    // Cố ý viết NGOÀI try: nhánh `throw` bên dưới không được `catch` ở trên
    // nuốt mất và thay bằng `String(e.message)` — lỗi "bridge không thấy file"
    // phải hiện nguyên văn tiếng Việt của ta, không phải "openwork_not_found".
    setOpenworkOverride(payload?.openwork ?? null);
    setWakeCandidates([]);
    onRecheck(); // config đã đổi — bảng trạng thái cũng phải thấy giá trị mới
    if (!openworkFoundOf(payload?.openwork)) {
      // Lỗi này đi qua `pathErr` (Banner đỏ), KHÔNG phải `pathMsg` (Banner
      // xanh): băng xanh nói "Đã lưu nhưng bridge vẫn không thấy file" đọc như
      // thành công có ngoặt.
      setPathErr("Đã lưu nhưng bridge vẫn không thấy file này — kiểm tra lại đường dẫn.");
      // Throw để `submit` GIỮ NGUYÊN ô gõ: đường dẫn này người dùng vừa gõ tay
      // hoặc vừa bấm "Dùng", xoá đi thì phải làm lại từ đầu đúng lúc app chưa
      // thấy exe. Giữ cả danh sách ứng viên vì còn giá trị để bấm tiếp.
      throw new Error("openwork_not_found");
    }
    // Xong thì đóng khối chọn, không chiếm màn hình.
    setEditing(false);
    // Không lặp lại "bấm Mở OpenWork…" ở đây: điều kiện hiện nút đó đã tự
    // dựng từ `openworkRunning` ngay phía trên, và chỉ hiện đúng lúc app chưa
    // mở. Nhánh app đang mở không cần hướng dẫn mở app.
    setPathMsg("Đã chỉ xong.");
  }

  /** Chép đường dẫn để dán chỗ khác. Clipboard API cần ngữ cảnh an toàn (https);
   * nếu trình duyệt chặn thì bôi đen giúp người dùng tự copy. */
  async function copyExePath(path) {
    try {
      await navigator?.clipboard?.writeText(path);
      setPathMsg(`Đã chép: ${path}`);
    } catch {
      setPathErr("Trình duyệt chặn chép tự động — bôi đen đường dẫn rồi copy tay.");
    }
  }

  // "Gỡ pairing" = quên máy đang kết nối trên điện thoại này (khóa vẫn nằm
  // trên máy; vào lại = quét/lấy mã ghép mới trong OpenPocket).
  function unpair() {
    const tenant = getTenant();
    askConfirm({
      title: "Gỡ pairing?",
      body: "Điện thoại này sẽ quên máy đang kết nối. Vào lại bằng cách lấy mã ghép mới trong OpenPocket trên máy tính.",
      confirmLabel: "Gỡ pairing",
      onConfirm: () => {
        removeKey(tenant); // dọn khóa khỏi chùm, hết chùm thì dọn luôn token
        notifyKeysChanged();
        if (getToken()) {
          onRecheck();
          navigate("#/");
        } else {
          onUnpaired();
        }
      },
    });
  }

  const rows = [
    ["Máy đang kết nối", getTenantName() || "máy chính (không phòng)"],
    ["openwork-server", state?.server ? `${state.server.baseUrl} (v${state.server.version})` : "chưa tìm thấy"],
    ["opencode", state?.server?.opencodeVersion ?? "—"],
    ["Token", state?.tokenActive ? "đang hoạt động" : state?.restartRequired ? "chờ restart OpenWork" : "đang kiểm tra…"],
    ["Engine", state?.engine ? `pid ${state.engine.pid} (port ${state.engine.enginePort})` : "—"],
    ["URL từ xa", state?.publicUrl ?? "—"],
    ["Tự mở OpenWork", state?.autoLaunchOpenWork ? "bật (bridge khởi động là mở)" : "tắt"],
    ["Bridge", `v${state?.bridgeVersion ?? "?"} · ${state?.dataDir ?? ""}`],
  ];

// `openwork` mới hơn boolean cũ `openworkExeFound`; thiếu object (bridge cũ) thì
  // lùi về boolean để không mất thông tin cũ. Cả hai cờ dùng helper của lib —
  // quy tắc "chỉ tin boolean thật, còn lại lùi về tín hiệu cũ" nằm ở MỘT chỗ
  // (`openworkFoundOf` / `openworkRunningOf`), trước đây viết tay ở bốn nơi.
  const openworkInfo = openworkOverride ?? state?.openwork ?? null;
  const openworkFound = openworkFoundOf(openworkInfo, state?.openworkExeFound);
  // Bridge cũ không gửi `running`; lúc đó đoán qua openwork-server — server sống
  // nghĩa là app đang mở, thay vì báo chết oan.
  const openworkRunning = openworkRunningOf(openworkInfo, state?.server);
  // Gộp HAI nguồn candidates (bridge đoán sẵn lúc /api/state + `wakeCandidates`
  // tích luỹ từ lỗi khi bấm "Bật OpenWork") rồi làm sạch bằng mergeCandidates.
  // Bản cũ ở đây là `new Set(...).filter(Boolean)` — chỉ lọc falsy, nên chuỗi
  // toàn khoảng trắng hay object truthy lọt vào và vẽ thành hàng CÓ NÚT "Dùng".
  const candidates = mergeCandidates(openworkInfo?.candidates, wakeCandidates);
  // Khối chọn đường dẫn: luôn mở khi chưa tìm thấy (đó là lúc cần nó), ngược lại
  // chỉ mở khi người dùng bấm "Đổi đường dẫn".
  const showChooser = !openworkFound || editing;
  // Nhãn trạng thái lấy từ lib/openwork-fix.js (một chỗ duy nhất) thay vì rải
  // điều kiện trong JSX. Hàm trả CHUỖI RỖNG khi chưa chắc đã cài — vậy hiện
  // nhãn "chưa thấy exe" của riêng chỗ này.
  const statusText =
    openworkStatusLabel(openworkInfo, {
      foundFallback: openworkFound,
      runningFallback: openworkRunning,
    }) || "chưa tìm thấy exe";

  return (
    <>
      {confirmDialog}
      <div class="card">
        <h3>Máy của tôi</h3>

        <div class="row-between" style="margin-bottom:var(--sp-3)">
          <b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {getTenantName() || "máy chính"}
          </b>
          {/* Trạng thái là câu, không phải bảng: đây là thứ người dùng thật sự
              cần biết. Bảng kỹ thuật nằm gập trong <details> bên dưới. */}
          <span class={`badge ${openworkRunning ? "ok" : "busy"}`}>{statusText}</span>
        </div>

        {/* Một hàng nút, một nút chính. "Kiểm tra lại" và "Quét lại máy tính"
            trước đây là HAI tên cho cùng một lệnh apiRecheck — gộp lại một. */}
        <div class="page-actions">
          <button class="btn small" disabled={busy} onClick={recheck}>
            {busy ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </button>
          {!openworkRunning && (
            <button class="btn small" disabled={waking} onClick={wake}>
              {waking ? "Đang bật…" : "Mở OpenWork"}
            </button>
          )}
        </div>
        {checkMsg && <p class="field-error" style="margin-top:10px" role="alert">{checkMsg}</p>}
        {wakeMsg && <p class="sheet-body" style="margin:10px 0 0">{wakeMsg}</p>}
        {pathErr && <Banner kind="err">{pathErr}</Banner>}
        {pathMsg && <Banner kind="ok">{pathMsg}</Banner>}

        {/* Phần cần thiết để sửa khi bridge không thấy exe. Chỉ mở lúc đó —
            không mở sẵn vì người dùng bình thường không cần gõ đường dẫn. */}
        {showChooser && (
          <div style="margin-top:var(--sp-4)">
            <OpenWorkFix candidates={candidates} onChoose={choosePath} saving={savingPath} />
          </div>
        )}

        {openworkFound && (
          <div class="page-actions" style="margin-top:12px">
            <button class="btn small" onClick={() => setEditing(!editing)}>
              {editing ? "Đóng" : "Đổi đường dẫn"}
            </button>
            {openworkInfo?.exe && (
              <button class="btn small ghost" onClick={() => copyExePath(openworkInfo.exe)}>
                Chép đường dẫn
              </button>
            )}
          </div>
        )}

        {/* Bảng kỹ thuật gập mặc định. 8 dòng này (pid, port, dataDir, URL từ xa)
            không phải thứ người dùng cần hằng ngày — mở sẵn nó chỉ làm màn
            Settings nặng nề và khiến những dòng quan trọng bị chôn. */}
        <details class="tech-details">
          <summary>Chi tiết kỹ thuật</summary>
          <table class="kv-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">{k}</th>
                  <td class="mono">{v}</td>
                </tr>
              ))}
              {/* Phiên bản OpenWork đứng riêng một dòng: ghép chung với đường dẫn
                  dài sẽ vỡ xuống dòng khoảng 4 dòng, đọc rối hơn là tách ra. */}
              {openworkFound && (
                <tr>
                  <th scope="row">OpenWork</th>
                  <td class="mono">
                    {openworkInfo?.version ? `v${openworkInfo.version}` : "không đọc được phiên bản"}
                  </td>
                </tr>
              )}
              {openworkInfo?.exe && (
                <tr>
                  <th scope="row">OpenWork</th>
                  <td class="mono">{openworkInfo.exe}</td>
                </tr>
              )}
            </tbody>
          </table>
        </details>

        {/* Nút phá hủy tách riêng khỏi cụm nút thường, không đứng cạnh nút chính
            (skill ux-layout-rules: nút phá hủy phải ra khỏi cụm). */}
        <div class="page-actions" style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--border)">
          <button class="btn small danger" onClick={unpair}>
            Gỡ pairing
          </button>
        </div>
      </div>

      <div class="card">
        <h3>Thiết bị đã ghép</h3>
        <p class="sheet-body">Thiết bị này: <b>{thisDeviceLabel || "—"}</b></p>
        {devices === null ? (
          <p class="sheet-body">Đang tải…</p>
        ) : devices.length === 0 ? (
          <p class="sheet-body">Chưa có thiết bị nào dùng mã ghép.</p>
        ) : (
          <div>
            {devices.map((d) => (
              <div class="file-row" key={d.id} style="cursor:default">
                <span class="icon"><PcsIcon size={20} /></span>
                <span class="name">
                  {d.label}
                  <span class="pair-hint" style="display:block">
                    ghép {new Date(d.createdAt).toLocaleString("vi-VN")} · hoạt động {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString("vi-VN") : "—"}
                  </span>
                </span>
                <button class="btn small danger" onClick={() => revoke(d)}>
                  Thu hồi
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
