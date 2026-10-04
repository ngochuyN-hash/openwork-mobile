import { useEffect, useRef, useState } from "preact/hooks";
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
  apiPairingCode,
  apiRestartTunnel,
  apiSetMachineName,
  ow,
  unwrap,
  owEngineReloadAll,
} from "../api.js";
import {
  formatPairingCountdown,
  pairingDeadline,
  pairingSecondsLeft,
} from "../lib/pairing-code.js";
import { useConfirm, Banner } from "../components/ui.jsx";
import { PcsIcon } from "../components/icons.jsx";
import { OpenWorkFix } from "../components/openwork-fix.jsx";
import {
  mergeCandidates,
  openworkFoundOf,
  openworkRunningOf,
  openworkStatusLabel,
} from "../lib/openwork-fix.js";
import {
  deviceListOf,
  formatDeviceTime,
  openworkInfoChanged,
  tunnelStatusLabel,
  tryCopyText,
} from "../lib/settings-state.js";
import { navigate } from "../app.jsx";

export function SettingsPage({ state, onRecheck, onUnpaired }) {
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");
  const [checkMsg, setCheckMsg] = useState("");
  const [confirmDialog, askConfirm] = useConfirm();
  const [devices, setDevices] = useState(null);
  const [devicesErr, setDevicesErr] = useState(false);
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

  // --- Nhóm 2: ghép thiết bị khác · tên máy · restart tunnel · nạp lại engine ---
  // Mã ghép: bridge trả `secondsLeft` TẠI THỜI ĐIỂM fetch nên phải quy về mốc
  // tuyệt đối (deadline) rồi đếm lùi mỗi giây — tin secondsLeft nguyên si là
  // đồng hồ đứng yên.
  const [pairing, setPairing] = useState(null); // {codeFormatted, pairUrl, deadline}
  const [pairingLeft, setPairingLeft] = useState(0);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingErr, setPairingErr] = useState("");
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMsg, setTunnelMsg] = useState("");
  const [machineEditing, setMachineEditing] = useState(false);
  const [machineName, setMachineName] = useState("");
  const [machineBusy, setMachineBusy] = useState(false);
  const [machineErr, setMachineErr] = useState("");
  const [reloading, setReloading] = useState(false);
  const [reloadMsg, setReloadMsg] = useState("");

  useEffect(() => {
    let alive = true;
    apiDevices()
      .then((list) => {
        if (alive) setDevices(deviceListOf(list));
      })
      .catch(() => {
        // Danh sách rỗng KÈM nhãn "không tải được" — trước đây lỗi ở đây hiện
        // y hệt "chưa có thiết bị nào", tức nói dối: máy CÓ thiết bị, ta chỉ
        // không đọc được danh sách.
        if (!alive) return;
        setDevices([]);
        setDevicesErr(true);
      });
    if (state?.thisDevice?.label) setThisDeviceLabel(state.thisDevice.label);
    return () => {
      alive = false;
    };
  }, [state?.thisDevice?.id]);

  // /api/state vừa về là sự thật mới nhất: bỏ giá trị tạm để tránh màn hình kẹt ở
  // kết quả cũ mãi (ví dụ vừa cài lại OpenWork ở chỗ khác, poll thấy path mới
  // nhưng UI vẫn vẽ path cũ vì override đè lên).
  //
  // PHẢI so NỘI DUNG, không so đồng nhất tham chiếu: app poll /api/state mỗi
  // 15s và mỗi lần JSON.parse sinh object `openwork` MỚI, nên `[state?.openwork]`
  // là deps luôn "đổi". Bản cũ vì thế xoá override đúng 15 giây sau khi bấm
  // "Chỉ đường dẫn" — kể cả khi poll CHƯA kịp thấy thay đổi — làm màn Cài đặt
  // quay về "chưa thấy exe" và mở lại khối chọn dù người dùng vừa làm đúng.
  const polledOpenwork = state?.openwork ?? null;
  const lastPolled = useRef(polledOpenwork);
  useEffect(() => {
    const prev = lastPolled.current;
    lastPolled.current = polledOpenwork;
    if (!openworkInfoChanged(prev, polledOpenwork)) return;
    setOpenworkOverride(null);
  }, [polledOpenwork]);

  // Đếm lùi mỗi giây khi mã ghép đang hiện.
  //
  // Bản cũ dựa vào `[pairing?.deadline]` và đọc `pairing.deadline` BÊN TRONG —
  // đúng một lần vì deadline là số, nhưng effect KHÔNG hề tự hủy khi hết hạn:
  // interval chạy mãi (mỗi giây một setState trên màn đang mở) và quan trọng hơn
  // là khi người dùng bấm "Đóng" (`setPairing(null)`) thì `pairing` không còn
  // nhưng deadline vẫn là số -> deps KHÔNG đổi -> effect không chạy lại -> timer
  // cũ tiếp tục setPairingLeft mãi mãi sau khi component con đã đóng. Giờ dừng
  // thật sự: về 0 là clearInterval, và "Đóng" cũng tắt vì `pairing` null.
  useEffect(() => {
    if (!pairing) return undefined;
    const tick = () => {
      const left = pairingSecondsLeft(pairing.deadline);
      setPairingLeft(left);
      if (left <= 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  async function revoke(device) {
    askConfirm({
      title: "Thu hồi thiết bị?",
      body: `"${device.label}" sẽ mất quyền truy cập vĩnh viễn (phải ghép lại bằng mã mới).`,
      confirmLabel: "Thu hồi",
      onConfirm: async () => {
        setDevicesErr(false);
        try {
          const payload = await apiRevokeDevice(device.id);
          // `deviceListOf` chuẩn hoá: bridge trả `{ok, devices}`, nhưng nếu
          // response thiếu `devices` thì `setDevices(undefined)` làm render vỡ
          // (`devices.length` của undefined) — sập trắng cả màn Cài đặt sau khi
          // đúng một cú bấm.
          setDevices(deviceListOf(payload));
        } catch {
          // Thu hồi hỏng (mạng, 404 vì thiết bị đã bị thu hồi từ máy khác) thì
          // báo, không im lặng — và nạp lại danh sách để không bỏ sót hàng cũ.
          setDevicesErr(true);
          try {
            setDevices(deviceListOf(await apiDevices()));
          } catch {
            /* giữ danh sách cũ */
          }
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
    // `tryCopyText` trả false cho CẢ "không có clipboard" và "writeText ném".
    // Bản cũ dùng `await navigator?.clipboard?.writeText(path)`: khi clipboard
    // undefined (http, quyền chưa cấp) `await undefined` vẫn resolve nên app báo
    // "Đã chép" dù chưa chép gì — người dùng sang chỗ khác dán ra chuỗi rỗng.
    if (await tryCopyText(navigator?.clipboard, path)) {
      setPathErr("");
      setPathMsg(`Đã chép: ${path}`);
    } else {
      setPathMsg("");
      setPathErr("Trình duyệt chặn chép tự động — bôi đen đường dẫn rồi copy tay.");
    }
  }

  // Tên máy hiện tại từ /api/state (bridge cũ không có edge.machineName → "—").
  // Khác "máy đang kết nối" phía trên: đó là tên PHÒNG (tenant), đây là tên
  // bridge tự mô tả — thiết bị ghép SAU sẽ thấy ở màn đăng nhập.
  const currentMachineName = state?.edge?.machineName ?? "";

  function startEditMachine() {
    setMachineName(currentMachineName);
    setMachineErr("");
    setMachineEditing(true);
  }

  async function saveMachineName() {
    if (!machineName.trim()) {
      setMachineErr("Tên máy trống.");
      return;
    }
    setMachineBusy(true);
    setMachineErr("");
    try {
      await apiSetMachineName(machineName);
      setMachineEditing(false);
      // /api/state về là dòng tên máy tự đổi — không cần banner xác nhận thêm.
      onRecheck();
    } catch (e) {
      setMachineErr(e.message === "UNPAIRED" ? "Chìa hết hiệu lực (401) — ghép lại để tiếp tục." : String(e.message || e));
    } finally {
      setMachineBusy(false);
    }
  }

  async function restartTunnel() {
    setTunnelBusy(true);
    setTunnelMsg("");
    try {
      await apiRestartTunnel();
      setTunnelMsg("Đã xin tunnel mới — chờ ~30 giây rồi bấm Kiểm tra lại để thấy URL mới.");
    } catch (e) {
      setTunnelMsg(e.message === "UNPAIRED" ? "Chìa hết hiệu lực (401) — ghép lại để tiếp tục." : String(e.message || e));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function loadPairingCode() {
    setPairingBusy(true);
    setPairingErr("");
    try {
      const p = await apiPairingCode();
      setPairing({
        codeFormatted: p.codeFormatted || `${String(p.code ?? "").slice(0, 4)}-${String(p.code ?? "").slice(4)}`,
        pairUrl: p.pairUrl ?? "",
        deadline: pairingDeadline(p.secondsLeft, Date.now()),
      });
      setPairingLeft(p.secondsLeft ?? 0);
    } catch (e) {
      setPairingErr(e.message === "UNPAIRED" ? "Chìa hết hiệu lực (401) — ghép lại để tiếp tục." : String(e.message || e));
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyPairUrl() {
    // Cùng lý do copyExePath: chỉ xoá lỗi khi chép THẬT, không phải khi
    // `await undefined` resolve.
    if (await tryCopyText(navigator?.clipboard, pairing?.pairUrl)) {
      setPairingErr("");
    } else {
      // Trình duyệt chặn clipboard (không https/chưa cấp quyền): lộ link ra
      // banner để bôi đen tự chép — vẫn hơn chết im.
      setPairingErr(`Trình duyệt chặn chép tự động — chép tay: ${pairing?.pairUrl ?? ""}`);
    }
  }

  /** Nạp lại engine mọi workspace (POST /workspace/:id/engine/reload). Desktop
   * có action tương đương trong Settings với fallback restart app — web không
   * tự restart app được, lỗi thì người dùng dùng nút "Mở OpenWork" phía trên. */
  async function reloadEngine() {
    setReloading(true);
    setReloadMsg("");
    try {
      const payload = await ow("/workspaces");
      const wss = unwrap(payload)?.workspaces ?? payload?.workspaces ?? [];
      if (!wss.length) {
        setReloadMsg("Không có workspace nào để nạp.");
        return;
      }
      const results = await owEngineReloadAll(wss.map((w) => w?.id));
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      setReloadMsg(
        failed.length
          ? `Nạp lại được ${okCount}/${results.length} workspace — lỗi: ${failed.map((f) => `${f.wsId}: ${f.error}`).join("; ")}.`
          : `Đã nạp lại engine ${okCount} workspace.`
      );
    } catch (e) {
      setReloadMsg(String(e.message || e));
    } finally {
      setReloading(false);
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

  // Trạng thái tunnel lấy từ `state.tunnel` (bridge/src/index.js gửi kèm mọi
  // lần /api/state) — bản cũ không hiển thị, nên khi cloudflared backoff
  // người dùng chỉ thấy "URL từ xa: —" và không hiểu vì sao không kết nối
  // được, dù nút "Khởi động lại tunnel" nằm ngay phía trên.
  const tunnel = tunnelStatusLabel(state?.tunnel);
  const rows = [
    ["Máy đang kết nối", getTenantName() || "máy chính (không phòng)"],
    ["openwork-server", state?.server ? `${state.server.baseUrl} (v${state.server.version})` : "chưa tìm thấy"],
    ["opencode", state?.server?.opencodeVersion ?? "—"],
    ["Token", state?.tokenActive ? "đang hoạt động" : state?.restartRequired ? "chờ restart OpenWork" : "đang kiểm tra…"],
    ["Engine", state?.engine ? `pid ${state.engine.pid} (port ${state.engine.enginePort})` : "—"],
    ["Tunnel", `${tunnel.label}${state?.tunnel?.url ? ` · ${state.tunnel.url}` : ""}`],
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

        {/* Tên máy (config bridge) khác tên phòng phía trên: thiết bị ghép SAU
            sẽ thấy tên này ở màn đăng nhập. Sửa inline — 1 giá trị, không đáng
            cả một sheet. */}
        <div class="row-between" style="margin-bottom:var(--sp-2)">
          {machineEditing ? (
            <>
              <input
                type="text"
                style="flex:1;min-width:0;margin-right:8px"
                value={machineName}
                maxLength={60}
                autocomplete="off"
                spellcheck={false}
                aria-label="Tên máy"
                onInput={(e) => setMachineName(e.currentTarget.value)}
              />
              <span class="page-actions" style="margin:0;flex-shrink:0">
                <button type="button" class="btn small" disabled={machineBusy || !machineName.trim()} onClick={saveMachineName}>
                  {machineBusy ? "Đang lưu…" : "Lưu"}
                </button>
                <button type="button" class="btn small ghost" onClick={() => setMachineEditing(false)}>
                  Đóng
                </button>
              </span>
            </>
          ) : (
            <>
              <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                Tên máy: <b>{currentMachineName || "—"}</b>
              </span>
              <button type="button" class="btn small ghost" style="flex-shrink:0" onClick={startEditMachine}>
                Sửa
              </button>
            </>
          )}
        </div>
        {machineErr && <p class="field-error" style="margin-top:6px" role="alert">{machineErr}</p>}

        {/* Một hàng nút, một nút chính. "Kiểm tra lại" và "Quét lại máy tính"
            trước đây là HAI tên cho cùng một lệnh apiRecheck — gộp lại một. */}
        <div class="page-actions">
          <button type="button" class="btn small" disabled={busy} onClick={recheck}>
            {busy ? "Đang kiểm tra…" : "Kiểm tra lại"}
          </button>
          {!openworkRunning && (
            <button type="button" class="btn small" disabled={waking} onClick={wake}>
              {waking ? "Đang bật…" : "Mở OpenWork"}
            </button>
          )}
          {/* Restart tunnel = thay cloudflared, GIỮ bridge — khác restart bridge
              (không đụng bộ đếm 429). Tunnel chết HẲN thì lệnh này không tới được
              máy: điện thoại phải bấm nút ↻ trên GUI máy tính, ghi rõ ở title. */}
          <button
            type="button"
            class="btn small ghost"
            disabled={tunnelBusy}
            onClick={restartTunnel}
            title="Xin tunnel mới khi đường về máy kẹt. Nếu tunnel đã chết hẳn (máy mất nối hoàn toàn) thì lệnh không tới được máy — phải bấm nút ↻ trên GUI máy tính."
          >
            {tunnelBusy ? "Đang khởi động lại…" : "Khởi động lại tunnel"}
          </button>
        </div>
        {checkMsg && <p class="field-error" style="margin-top:10px" role="alert">{checkMsg}</p>}
        {wakeMsg && <p class="sheet-body" style="margin:10px 0 0">{wakeMsg}</p>}
        {tunnelMsg && <p class="sheet-body" style="margin:10px 0 0">{tunnelMsg}</p>}
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
            <button type="button" class="btn small" onClick={() => setEditing(!editing)}>
              {editing ? "Đóng" : "Đổi đường dẫn"}
            </button>
            {openworkInfo?.exe && (
              <button type="button" class="btn small ghost" onClick={() => copyExePath(openworkInfo.exe)}>
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
              {/* Phiên bản + đường dẫn OpenWork đứng riêng mỗi dòng: ghép
                  chung với đường dẫn dài sẽ vỡ xuống dòng khoảng 4 dòng, đọc
                  rối hơn là tách ra.
                  Nhãn KHÁC NHAU ("Phiên bản" / "Đường dẫn") — bản cũ ghi cả hai
                  là "OpenWork", giống hệt nhau trong một bảng, đọc như cột bị
                  lặp. */}
              {openworkFound && (
                <tr>
                  <th scope="row">Phiên bản</th>
                  <td class="mono">
                    {openworkInfo?.version ? `v${openworkInfo.version}` : "không đọc được phiên bản"}
                  </td>
                </tr>
              )}
              {openworkInfo?.exe && (
                <tr>
                  <th scope="row">Đường dẫn</th>
                  <td class="mono">{openworkInfo.exe}</td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Bảo trì hiếm khi cần, nên chôn trong details: nạp lại engine sau
              khi đổi MCP/plugin trên máy hoặc engine dựng dở (desktop có action
              tương đương trong Settings, kèm fallback restart app). */}
          <div class="page-actions" style="margin-top:var(--sp-3)">
            <button
              type="button"
              class="btn small ghost"
              disabled={reloading}
              onClick={reloadEngine}
              title="Nạp lại engine của các workspace — dùng sau khi đổi MCP/plugin trên máy hoặc khi engine dựng dở"
            >
              {reloading ? "Đang nạp lại…" : "Nạp lại engine"}
            </button>
          </div>
          {reloadMsg && <p class="sheet-body" style="margin:8px 0 0">{reloadMsg}</p>}
        </details>

        {/* Nút phá hủy tách riêng khỏi cụm nút thường, không đứng cạnh nút chính
            (skill ux-layout-rules: nút phá hủy phải ra khỏi cụm). */}
        <div class="page-actions" style="margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--border)">
          <button type="button" class="btn small danger" onClick={unpair}>
            Gỡ pairing
          </button>
        </div>
      </div>

      <div class="card">
        <h3>Thiết bị đã ghép</h3>
        <p class="sheet-body">Thiết bị này: <b>{thisDeviceLabel || "—"}</b></p>

        {/* Ghép thiết bị KHÁC ngay từ điện thoại: hiện mã one-time đang sống
            trên bridge cho máy mới nhập ở màn Đăng nhập (hoặc mở link mời).
            Điện thoại này chỉ "đứng cạnh" hiển thị mã — mã thật nằm trên bridge,
            dùng đúng 1 lần, 30 phút tự hết hạn, sai giới hạn 10 lần/phút/IP.
            Cố ý KHÔNG vẽ masterUrl/masterQr: token vĩnh viễn chỉ nên nằm trong
            terminal/GUI trên máy tính, không vẽ lên màn hình điện thoại. */}
        <div style="margin-top:var(--sp-2);padding-top:var(--sp-3);border-top:1px solid var(--border)">
          {!pairing ? (
            <button type="button" class="btn small" disabled={pairingBusy} onClick={loadPairingCode}>
              {pairingBusy ? "Đang lấy mã…" : "Ghép thiết bị khác"}
            </button>
          ) : (
            <div>
              <div class="row-between" style="margin-bottom:4px">
                <span class="mono pair-code">{pairing.codeFormatted}</span>
                <span class={`badge ${pairingLeft > 0 ? "busy" : "err"}`}>
                  {pairingLeft > 0 ? `còn ${formatPairingCountdown(pairingLeft)}` : "hết hạn"}
                </span>
              </div>
              <p class="sheet-body">
                Trên thiết bị mới: mở app → màn Đăng nhập → nhập mã trên, hoặc mở link mời. Mã dùng đúng 1 lần.
              </p>
              <div class="page-actions">
                <button type="button" class="btn small ghost" onClick={copyPairUrl}>
                  Sao chép link mời
                </button>
                {/* Khi mã còn sống bridge trả đúng mã cũ (ensureCode) — nút
                    "lấy mã khác" lúc này là nút vô nghĩa, chỉ hiện khi hết hạn. */}
                {pairingLeft <= 0 && (
                  <button type="button" class="btn small" disabled={pairingBusy} onClick={loadPairingCode}>
                    Lấy mã mới
                  </button>
                )}
                <button type="button" class="btn small ghost" onClick={() => setPairing(null)}>
                  Đóng
                </button>
              </div>
            </div>
          )}
          {pairingErr && <Banner kind="err">{pairingErr}</Banner>}
        </div>

        {/* `devicesErr` tách khỏi `devices.length === 0`: lỗi mạng / 401 và
            "chưa có thiết bị nào" là hai câu khác nhau, gộp làm một thì
            người dùng tưởng máy không có thiết bị nào trong khi thực ra ta
            chưa đọc được danh sách. */}
        {devices === null ? (
          <p class="sheet-body">Đang tải…</p>
        ) : devicesErr && devices.length === 0 ? (
          <p class="sheet-body">Không đọc được danh sách thiết bị (lỗi mạng hoặc chìa hết hiệu lực). Bấm Kiểm tra lại ở trên.</p>
        ) : devices.length === 0 ? (
          <p class="sheet-body">Chưa có thiết bị nào dùng mã ghép.</p>
        ) : (
          <div>
            {devicesErr && (
              <p class="field-error" style="margin:0 0 8px" role="alert">
                Danh sách dưới đây có thể đã cũ — vừa có lỗi khi tải/thu hồi.
              </p>
            )}
            {devices.map((d) => (
              <div class="file-row" key={d.id} style="cursor:default">
                <span class="icon"><PcsIcon size={20} /></span>
                <span class="name">
                  {d.label}
                  <span class="pair-hint" style="display:block">
                    ghép {formatDeviceTime(d.createdAt)} · hoạt động {d.lastSeenAt ? formatDeviceTime(d.lastSeenAt) : "—"}
                  </span>
                </span>
                <button type="button" class="btn small danger" aria-label={`Thu hồi thiết bị ${d.label}`} onClick={() => revoke(d)}>
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
