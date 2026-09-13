// WebRTC P2P cho tab Màn hình — phone và PC tự nối trực tiếp qua UDP, bridge
// chỉ làm mối SDP/ICE đúng MỘT lượt (POST /api/webrtc/signal). Sau đó:
//   - datachannel "screen"  : JPEG frame nhị phân PC -> phone (1 message = 1 frame)
//   - datachannel "control" : JSON hai chiều — hello/ping/probe/input/đứng-yêu
// Đường hình KHÔNG qua tunnel/worker nữa → latency = mạng thật giữa 2 máy.
// Cùng thư viện node-datachannel mà 9remote dùng.
//
// ICE: STUN công khai đục NAT nhẹ. Khi phone ở MẠNG KHÁC (4G/WiFi nhà khác) mà
// cả hai bên dính NAT đối xứng (CGNAT nhà mạng) thì đục thẳng fail — cần TURN
// TRUNG CHUYỂN. Chủ máy cấu hình Cloudflare TURN key trong config.json
// (turnKeyId + turnToken, dashboard → Calls → TURN): bridge tự sinh credential
// tạm 24h và phát cho phone qua GET /api/webrtc/ice (1 request nhỏ/lượt xem,
// không ảnh hưởng nhịp hình). CF có node tại VN nên đường relay ~20-60ms —
// openrelay free đã chết từ VN (test 13/09: 0 relay candidate cả UDP lẫn TCP).
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.js";

const STUN_SERVERS = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const GATHER_TIMEOUT_MS = 2500; // chờ gom candidate của mình (non-trickle)
const SIGNAL_TIMEOUT_MS = 6000; // trần chung của cả lượt làm mối
const TURN_TTL_S = 86_400; // credential CF sống 24h

let iceCache = null; // { iceServers, expiresAt } — memoize giữa các lượt

/**
 * Danh sách iceServers (dạng chuẩn browser: {urls, username, credential}).
 * Có TURN CF khi config có key; không thì STUN thôi (hành vi cũ).
 */
export async function webrtcIceServers() {
  if (iceCache && iceCache.expiresAt > Date.now() + 60_000) return iceCache.iceServers;
  const config = loadConfig();
  if (config.turnKeyId && config.turnToken) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: "Bearer " + config.turnToken, "content-type": "application/json" },
          body: JSON.stringify({ ttl: TURN_TTL_S }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        // CF trả cả URL port 53 — browser chặn, mà mình non-trickle nên URL
        // chết làm chậm gom candidate: lọc bỏ trước khi phát (docs CF dặn).
        const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : [])
          .map((s) => ({ urls: Array.isArray(s.urls) ? s.urls : [s.urls], username: s.username, credential: s.credential }))
          .map((s) => ({ ...s, urls: s.urls.filter((u) => !/:53([/?]|$)/.test(String(u))) }))
          .filter((s) => s.urls.length);
        if (iceServers.length) {
          iceCache = { iceServers, expiresAt: Date.now() + (TURN_TTL_S - 3600) * 1000 };
          return iceCache.iceServers;
        }
      }
    } catch {
      // CF không trả lời → rơi về STUN (đường direct vẫn chạy khi NAT cho phép)
    }
  }
  return [{ urls: [...STUN_SERVERS] }];
}

/** Đổi iceServers browser-style thành chuỗi url nhúng user:pass cho node-datachannel. */
function iceServersToNdc(iceServers) {
  const out = [];
  for (const s of iceServers) {
    for (const u of s.urls ?? []) {
      if (s.username && s.credential) {
        // credential CF là hex + username hex — an toàn để nhúng thẳng URL
        out.push(String(u).replace(/^(turn[s]?):/i, `$1:${s.username}:${s.credential}@`));
      } else {
        out.push(String(u));
      }
    }
  }
  return out;
}

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
      iceServers: iceServersToNdc(await webrtcIceServers()),
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
    } else if (m.t === "probe") {
      // Đo phản hồi bấm→hình: đánh thức vòng chụp NGAY nhưng KHÔNG có lệnh
      // input thật (không di chuột trên máy chủ) — phone chặn giờ tới frame kế.
      this.screen.poke();
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
