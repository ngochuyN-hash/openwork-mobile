// WebRTC P2P cho tab Màn hình — phone và PC tự nối trực tiếp qua UDP, bridge
// chỉ làm mối SDP/ICE đúng MỘT lượt (POST /api/webrtc/signal). Sau đó:
//   - datachannel "screen"  : JPEG frame nhị phân PC -> phone (1 message = 1 frame)
//   - datachannel "control" : JSON hai chiều — hello/ping/input/đứng-yêu
// Đường hình KHÔNG qua tunnel/worker nữa → latency = mạng thật giữa 2 máy
// (cùng WiFi ~2-10ms; xa xa vẫn tốt hơn đường CF nhiều lần). Cùng thư viện
// node-datachannel mà 9remote dùng, STUN công khai để xuyên NAT nhẹ.
import { randomBytes } from "node:crypto";

const STUN_SERVERS = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const GATHER_TIMEOUT_MS = 2500; // chờ gom candidate của mình (non-trickle)
const SIGNAL_TIMEOUT_MS = 6000; // trần chung của cả lượt làm mối

export class WebRtcService {
  constructor(screen) {
    this.screen = screen;
    this.actors = new Set(); // PeerConnection đang sống
  }

  /**
   * Nhận offer (+candidate) của phone, trả answer (+candidate) của PC.
   * Không trickle — cả hai bên gom đủ candidate mới gửi, chỉ 1 request/lượt.
   */
  async handleSignal(body) {
    let mod;
    try {
      mod = await import("node-datachannel");
    } catch (error) {
      throw new Error(`WebRTC không khả dụng trên máy này: ${error.message}`);
    }
    const ndc = mod.default ?? mod;
    const pc = new ndc.PeerConnection("owp-" + randomBytes(4).toString("hex"), {
      iceServers: STUN_SERVERS,
    });

    let localDesc = null;
    let gathered = false;
    const localCandidates = [];
    pc.onLocalDescription((sdp, type) => { localDesc = { type, sdp }; });
    pc.onLocalCandidate((candidate, mid) => localCandidates.push({ candidate, mid }));
    pc.onGatheringStateChange((s) => { if (s === "complete") gathered = true; });
    pc.onStateChange((s) => {
      if (s === "disconnected" || s === "failed" || s === "closed") this.dispose(pc);
    });
    pc.onDataChannel((ch) => this.wire(pc, ch));

    pc.setRemoteDescription(String(body?.sdp ?? ""), "offer");
    for (const c of (Array.isArray(body?.candidates) ? body.candidates.slice(0, 40) : [])) {
      try { pc.addRemoteCandidate(String(c.candidate), String(c.mid ?? "0")); } catch {}
    }

    const t0 = Date.now();
    while ((!localDesc || (!gathered && Date.now() - t0 < GATHER_TIMEOUT_MS)) && Date.now() - t0 < SIGNAL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (!localDesc) {
      this.dispose(pc);
      throw new Error("Không gom được SDP answer trong " + SIGNAL_TIMEOUT_MS + "ms");
    }
    this.actors.add(pc);
    return { type: localDesc.type, sdp: localDesc.sdp, candidates: localCandidates };
  }

  /** Gắn 2 datachannel do phone tạo trước (offer chứa sẵn "control" + "screen"). */
  wire(pc, ch) {
    const label = ch.getLabel();
    if (label === "screen") {
      pc._scr = ch;
      ch.onOpen(() => {
        if (pc._ctl && !pc._viewer) {
          const p = pc._hello ?? {};
          pc._viewer = this.screen.addDcViewer(pc._ctl, ch, { w: p.w, q: p.q });
        }
      });
      ch.onClosed(() => {
        if (pc._viewer) { this.screen.removeViewer(pc._viewer); pc._viewer = null; }
      });
    } else if (label === "control") {
      pc._ctl = ch;
      ch.onMessage((msg) => this.onControl(pc, ch, msg));
    }
  }

  onControl(pc, ch, msg) {
    let m = null;
    try {
      m = JSON.parse(typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8"));
    } catch { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "hello") {
      pc._hello = { w: Number(m.w) || 880, q: Number(m.q) || 55 };
      if (pc._viewer) { pc._viewer.width = pc._hello.w; pc._viewer.quality = pc._hello.q; }
    } else if (m.t === "ping") {
      try { ch.sendMessage(JSON.stringify({ t: "pong", ts: m.ts })); } catch {}
    } else if (m.t === "input") {
      // Lệnh điều khiển đi đường trực tiếp — một chiều, không chờ hồi âm; lỗi
      // mới báo lại. poke() nằm trong screen.input() nên hình chụp ngay nhịp kế.
      this.screen.input(m).catch((e) => {
        try { ch.sendMessage(JSON.stringify({ t: "ierr", m: String(e.message ?? e) })); } catch {}
      });
    }
  }

  dispose(pc) {
    if (!this.actors.has(pc)) return;
    this.actors.delete(pc);
    if (pc._viewer) { try { this.screen.removeViewer(pc._viewer); } catch {} pc._viewer = null; }
    try { pc.close(); } catch {}
  }

  disposeAll() {
    for (const pc of [...this.actors]) this.dispose(pc);
  }
}
