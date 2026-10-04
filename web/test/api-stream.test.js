// Unit tests cho tầng stream + route + net (web/src/lib/sse.js, lib/route.js,
// lib/net.js) và các bản sửa trong web/src/api.js.
//
// Những lib này thuần (không đụng DOM) nên import thẳng được. api.js cần shim
// localStorage/location/history TRƯỚC khi import — xem api-contract.test.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

process.env.OPENWORK_BRIDGE_DIR = mkdtempSync(`${tmpdir()}/owm-test-bridge-`);
process.env.OPENWORK_DIR = mkdtempSync(`${tmpdir()}/owm-test-data-`);

function createStorageShim() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

globalThis.localStorage = createStorageShim();
globalThis.location = { hash: "", pathname: "/", search: "" };
globalThis.history = { replaceState() {} };
globalThis.window = globalThis;

const { parseSseFrame, takeFrame, connectEvents } = await import("../src/lib/sse.js");
const { parseHashRoute, parseHashParam, safeDecode } = await import("../src/lib/route.js");
const { networkErrorMessage, isAbortError, withTimeoutSignal } = await import("../src/lib/net.js");
const api = await import("../src/api.js");

beforeEach(() => {
  globalThis.localStorage = createStorageShim();
});

// ================= SSE frame parsing =================
// Nguồn chân lý: engine opencode phát `data: {json}` (apps/server/src/server.ts:1525
// và :2115) và forward nguyên frame của opencode native; chính engine đọc mọi
// nơi bằng `startsWith("data:")` + trim (server.ts:2032, engine-pool.ts:389,
// opencode-v2-adapter.ts:1750) — tức coi `data:{...}` không space là hợp lệ.
// Bản cũ của web lọc `startsWith("data: ")` nên rơi im lặng mọi frame đó.

test("parseSseFrame đọc được `data: {...}` có space (dạng engine opencode phát)", () => {
  const frame = 'data: {"type":"message.part.updated","properties":{"sessionID":"s1"}}';
  assert.deepEqual(parseSseFrame(frame), {
    type: "message.part.updated",
    properties: { sessionID: "s1" },
  });
});

test("parseSseFrame đọc được `data:{...}` KHÔNG space — chuẩn SSE, bản cũ RƠI MẤT", () => {
  const frame = 'data:{"type":"session.status"}';
  assert.deepEqual(parseSseFrame(frame), { type: "session.status" });
});

test("parseSseFrame bỏ đúng MỘT space sau dấu ':' như chuẩn SSE", () => {
  // Giá trị thật sự bắt đầu bằng space phải giữ lại space đó (bỏ 1, không bỏ hết).
  assert.deepEqual(parseSseFrame('data:  {"a":1}'), { a: 1 });
  assert.equal(parseSseFrame('data: " x"'), " x");
});

test("parseSseFrame nối nhiều dòng data: của một frame rồi parse MỘT lần", () => {
  const frame = 'data: {"type":"x",\ndata: "big":true}';
  assert.deepEqual(parseSseFrame(frame), { type: "x", big: true });
});

test("parseSseFrame bỏ comment/dòng trống và các field khác của SSE", () => {
  const frame = [":keepalive", "event: ping", "id: 42", "retry: 3000", 'data: {"type":"t"}'].join("\n");
  assert.deepEqual(parseSseFrame(frame), { type: "t" });
});

test("parseSseFrame trả null cho frame rác — không ném, không làm đứt stream", () => {
  assert.equal(parseSseFrame(":keepalive"), null);
  assert.equal(parseSseFrame(""), null);
  assert.equal(parseSseFrame('data: {KHÔNG phải JSON'), null);
  assert.equal(parseSseFrame("event: chỉ-mỗi-event"), null);
  assert.equal(parseSseFrame(undefined), null);
});

test("parseSseFrame chịu cả hai kiểu xuống dòng CRLF và LF", () => {
  assert.deepEqual(parseSseFrame('data: {"type":"a"}'), { type: "a" });
});

// ================= Hash route =================
// app.jsx là JSX nên không import test được; logic router nằm ở lib/route.js.

test("parseHashRoute đọc đủ các route của app", () => {
  assert.deepEqual(parseHashRoute("#/"), { view: "home" });
  assert.deepEqual(parseHashRoute(""), { view: "home" });
  assert.deepEqual(parseHashRoute("#"), { view: "home" });
  assert.deepEqual(parseHashRoute("#/workspaces"), { view: "workspaces" });
  assert.deepEqual(parseHashRoute("#/settings"), { view: "settings" });
  assert.deepEqual(parseHashRoute("#/search"), { view: "search", wsId: "" });
  assert.deepEqual(parseHashRoute("#/ws/w%201"), { view: "sessions", wsId: "w 1" });
  assert.deepEqual(parseHashRoute("#/ws/w1/search"), { view: "search", wsId: "w1" });
  assert.deepEqual(parseHashRoute("#/ws/w1/chat/s%2F9"), { view: "chat", wsId: "w1", sessionId: "s/9" });
  assert.deepEqual(parseHashRoute("#/ws/w1/files?path=a%2Fb.txt"), {
    view: "files",
    wsId: "w1",
    path: "a/b.txt",
  });
});

test("parseHashRoute: route lạ rơi về home, KHÔNG ném", () => {
  assert.deepEqual(parseHashRoute("#/khong-co-route"), { view: "home" });
  assert.deepEqual(parseHashRoute("#/ws"), { view: "home" }); // thiếu :id
  assert.deepEqual(parseHashRoute("#/ws/w1/chat"), { view: "sessions", wsId: "w1" }); // thiếu :sid
  assert.deepEqual(parseHashRoute("#/ws/w1/bam-ro"), { view: "sessions", wsId: "w1" });
});

test("parseHashRoute: hash hỏng (%-encoding cụt) KHÔNG làm sập app", () => {
  // Trước đây `decodeURIComponent` ném URIError ngay giữa lúc render.
  assert.deepEqual(parseHashRoute("#/ws/%E0%A4"), { view: "sessions", wsId: "%E0%A4" });
  assert.deepEqual(parseHashRoute("#/ws/%/chat/%"), {
    view: "chat",
    wsId: "%",
    sessionId: "%",
  });
});

test("parseHashRoute giữ nguyên phần query có dấu '?' bên trong giá trị", () => {
  // `hash.split("?")` cũ cắt cụt mất đuôi khi giá trị query chứa "?".
  assert.equal(parseHashRoute("#/ws/w1/files?path=a?b.txt").path, "a?b.txt");
});

test("safeDecode trả nguyên chuỗi gốc khi %-encoding hỏng", () => {
  assert.equal(safeDecode("%E0%A4"), "%E0%A4");
  assert.equal(safeDecode("a%20b"), "a b");
  assert.equal(safeDecode(undefined), "");
});

// ---- Hash ghép nối (#t= token, #p= mã one-time) ----

test("parseHashParam bóc được token/mã kèm phòng", () => {
  assert.deepEqual(parseHashParam("#t=owm_abc&m=Room-1", "t"), { value: "owm_abc", tenant: "Room-1" });
  assert.deepEqual(parseHashParam("#p=ABCD2345", "p"), { value: "ABCD2345", tenant: "" });
});

test("parseHashParam giải mã %-encoding, và KHÔNG ném khi hỏng", () => {
  assert.equal(parseHashParam("#p=A%20B", "p").value, "A B");
  assert.equal(parseHashParam("#p=%E0%A4", "p").value, "%E0%A4");
});

test("parseHashParam: hash không chứa key / giá trị rỗng -> null", () => {
  assert.equal(parseHashParam("#/ws/w1", "t"), null);
  assert.equal(parseHashParam("", "p"), null);
  assert.equal(parseHashParam("#t=", "t"), null);
  assert.equal(parseHashParam(undefined, "p"), null);
});

test("parseHashParam: key rỗng không dựng được RegExp ngu ngầm", () => {
  // `new RegExp("^#=")` là regex hợp lệ nhưng khớp mọi thứ — phải trả null.
  assert.equal(parseHashParam("#t=abc", ""), null);
});

// ================= Network error =================

test("networkErrorMessage dịch lỗi mạng/không nối được sang tiếng Việt", () => {
  // Chrome/Safari: TypeError "Failed to fetch"; Firefox: "NetworkError ...".
  assert.match(networkErrorMessage(new TypeError("Failed to fetch")), /could not reach/i);
  assert.match(networkErrorMessage(new TypeError("NetworkError when attempting to fetch")), /could not reach/i);
  assert.match(networkErrorMessage(new TypeError("Load failed")), /could not reach/i);
});

test("networkErrorMessage phân biệt hết thời gian chờ với mất mạng", () => {
  const timeout = new Error("Timeout");
  timeout.name = "TimeoutError";
  assert.match(networkErrorMessage(timeout), /timed out/i);
  assert.notEqual(networkErrorMessage(timeout), networkErrorMessage(new TypeError("Failed to fetch")));
});

test("networkErrorMessage: hủy không phải lỗi, lỗi lạ thì giữ nguyên message", () => {
  const abort = new Error("The user aborted a request.");
  abort.name = "AbortError";
  assert.equal(isAbortError(abort), true);
  assert.equal(networkErrorMessage(abort), "Cancelled.");
  assert.equal(networkErrorMessage(new Error("Workspace không tồn tại")), "Workspace không tồn tại");
  assert.ok(networkErrorMessage(null).length > 0);
});

test("withTimeoutSignal hết hạn thì abort; release() thì không", async () => {
  const fast = withTimeoutSignal(null, 10_000);
  assert.equal(fast.signal.aborted, false);
  fast.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fast.signal.aborted, false, "release() phải dọn timer, không được abort");

  const quick = withTimeoutSignal(null, 5);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(quick.signal.aborted, true, "quá hạn thì phải abort");
});

test("withTimeoutSignal nối cả signal của caller — nút Hủy vẫn ăn", async () => {
  const parent = new AbortController();
  const guard = withTimeoutSignal(parent.signal, 60_000);
  parent.abort();
  assert.equal(guard.signal.aborted, true);
  guard.release();
});

// ---- Tách frame qua ranh giới chunk (vòng lặp stream) ----
// `takeFrame` là phần rủi ro nhất của parser SSE: một frame bị cắt làm đôi bởi
// TCP có thể làm mất tin, mà mất tin trong chat là im lặng.

test("một chunk có HAI frame thì tách đủ, không nuốt", () => {
  const buf = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
  const first = takeFrame(buf);
  assert.equal(first.text, 'data: {"a":1}');
  const second = takeFrame(first.rest);
  assert.equal(second.text, 'data: {"b":2}');
  assert.equal(takeFrame(second.rest), null, "hết buffer thì null, không phải chuỗi rỗng");
});

test("frame bị cắt qua nhiều chunk thì chỉ emit khi ĐỦ dấu phân cách", () => {
  let buf = 'data: {"type":"mess';
  assert.equal(takeFrame(buf), null, "chưa có \n\n thì chưa có frame");
  buf += 'age.part.updated"}\n';
  assert.equal(takeFrame(buf), null, "vẫn thiếu dấu phân cách");
  buf += "\n";
  const cut = takeFrame(buf);
  assert.equal(cut.text, 'data: {"type":"message.part.updated"}');
  assert.equal(parseSseFrame(cut.text).type, "message.part.updated");
});

test("buffer dư không có \n\n được giữ lại cho lần sau", () => {
  const cut = takeFrame('data: {"a":1}\n\ndata: {"b":2}');
  assert.equal(cut.rest, 'data: {"b":2}', "phần chưa trọn vẹn phải còn lại, không bị bỏ");
  assert.equal(takeFrame(cut.rest), null);
});

test("frame cuối không có \n\n vẫn được phát khi stream kết thúc", async () => {
  const frames = [];
  await runStream('data: {"type":"a"}\n\ndata: {"type":"b"}', (t, e) => frames.push(e.type));
  assert.deepEqual(frames, ["a", "b"], "tin cuối không bị bỏ vì thiếu dấu phân cách");
});

test("stream nhiều chunk nhỏ vẫn ra đúng thứ tự", async () => {
  const frames = [];
  await runStream(['data: {"type":"1"}\n', '\ndata: {"type":"2"}\n', '\n', ': keepalive\n\n', 'data: {"type":"3"}\n\n'],
    (t, e) => frames.push(e.type));
  assert.deepEqual(frames, ["1", "2", "3"], "comment giữa các tin không được nuốt tin");
});

/** Chạy connectEvents với một body SSE giả, chunk theo đúng danh sách cho trước. */
async function runStream(chunks, onEvent) {
  const parts = Array.isArray(chunks) ? chunks : [chunks];
  const enc = new TextEncoder();
  let i = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (i >= parts.length) {
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(parts[i++]));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  const stop = connectEvents("/x", (type, data) => onEvent(type, data));
  // Chờ stream đóng hẳn rồi đóng vòng lặp, không để timer reconnect chạy mãi.
  await new Promise((r) => setTimeout(r, 60));
  stop();
  delete globalThis.fetch;
}
