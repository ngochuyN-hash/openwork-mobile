import { render } from "preact";
import { App } from "./app.jsx";
import { absorbTokenFromHash } from "./api.js";
import "./styles.css";

// Tự pair nếu mở từ link/QR dạng .../#t=<token>, rồi render app.
absorbTokenFromHash();

render(<App />, document.getElementById("app"));

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
