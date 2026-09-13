#!/usr/bin/env node
// Tự test đường WebRTC datachannel của bridge KHÔNG cần phone thật: script này
// đóng vai phone (bên offer), bắt tay qua /api/webrtc/signal, rồi đo thật
// fps + KB/s + ping trên datachannel "screen"/"control".
//   node scripts/screen-webrtc-selftest.mjs <base> <mobileToken> [số giây]
import NodeDataChannel from "node-datachannel";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8789").replace(/\/+$/, "");
const TOKEN = process.argv[3] ?? "";
const DURATION_MS = Math.round(Number(process.argv[4] ?? 20) * 1000);
if (!TOKEN) {
  console.error("dùng: node scripts/screen-webrtc-selftest.mjs <base> <mobileToken> [giây]");
  process.exit(1);
}

const pc = new NodeDataChannel.PeerConnection("selftest", {
  iceServers: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
});
const candidates = [];
pc.onLocalCandidate((candidate, mid) => candidates.push({ candidate, mid }));
const scr = pc.createDataChannel("screen");
const ctl = pc.createDataChannel("control");

// Non-trickle như phía phone thật: gom đủ candidate rồi gửi 1 lượt.
await pc.setLocalDescription("offer");
await new Promise((res) => {
  if (pc.gatheringState() === "complete") return res();
  const t = setTimeout(res, 2500);
  pc.onGatheringStateChange((s) => { if (s === "complete") { clearTimeout(t); res(); } });
});

const res = await fetch(BASE + "/api/webrtc/signal", {
  method: "POST",
  headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ sdp: pc.localDescription().sdp, type: "offer", candidates }),
});
if (!res.ok) {
  console.error("signal lỗi HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const ans = await res.json();
pc.setRemoteDescription(ans.sdp, ans.type);
for (const c of ans.candidates ?? []) {
  try { pc.addRemoteCandidate(c.candidate, c.mid); } catch {}
}
console.log("đã bắt tay signal — chờ datachannel mở...");

let frames = 0, bytes = 0, tick = Date.now(), lastFps = 0, pings = [];
scr.onOpen(() => {
  console.log("datachannel screen MỞ — bắt đầu nhận frame");
  ctl.sendMessage(JSON.stringify({ t: "hello", w: 880, q: 55 }));
  setInterval(() => {
    try { ctl.sendMessage(JSON.stringify({ t: "ping", ts: Date.now() })); } catch {}
  }, 2000);
});
scr.onMessage((msg) => {
  frames++;
  bytes += msg.length ?? msg.byteLength ?? 0;
  const now = Date.now();
  if (now - tick >= 1000) {
    lastFps = frames;
    const pingAvg = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) + "ms" : "…";
    console.log(`fps: ${frames} | ${(bytes / 1024).toFixed(0)} KB/s | ping TB: ${pingAvg}`);
    frames = 0; bytes = 0; tick = now; pings = [];
  }
});
ctl.onMessage((msg) => {
  try {
    const m = JSON.parse(String(msg));
    if (m.t === "pong") pings.push(Date.now() - m.ts);
  } catch {}
});
pc.onStateChange((s) => console.log("[pc]", s));
setTimeout(() => {
  try {
    const sp = pc.getSelectedCandidatePair();
    if (sp) {
      console.log("candidate pair:", (sp.local.type ?? "?") + " " + sp.local.ip, "<->", (sp.remote.type ?? "?") + " " + sp.remote.ip, "| rtt():", pc.rtt() + "ms");
    }
  } catch {}
  console.log(`xong — fps giây cuối: ${lastFps}`);
  process.exit(0);
}, DURATION_MS);
