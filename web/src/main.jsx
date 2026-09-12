import { render } from "preact";
import { App } from "./app.jsx";
import { absorbTokenFromHash } from "./api.js";
import "./styles.css";

// Tự pair nếu mở từ link/QR dạng .../#t=<token>, rồi render app.
absorbTokenFromHash();

render(<App />, document.getElementById("app"));

// Đăng ký SW cả trên http://localhost (dev) lẫn https (prod/Tailscale).
// Chỉ bỏ qua khi đang chạy vite dev (có HMR) để khỏi kẹt cache cũ.
if ("serviceWorker" in navigator && !location.host.startsWith("127.0.0.1:51") && !location.host.startsWith("localhost:51")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
