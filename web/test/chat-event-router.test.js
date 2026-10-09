// Khoá lib/chat-event-router (round 4, 09/10 — tách khỏi mega-effect của
// chat.jsx): event nào gọi loader nào, ai chốt running — ghim hết với deps giả.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatEventRouter } from "../src/lib/chat-event-router.js";

function makeDeps(over = {}) {
  const calls = { loadSession: 0, loadTodo: 0, loadPermissions: 0, scheduleStatus: 0, scheduleOther: 0, scheduleFlush: 0 };
  const deps = {
    sessionId: "ses_1",
    lastEventAt: { current: 0 },
    setRunning: (v) => (deps.running = v),
    loadSession: () => calls.loadSession++,
    loadTodo: () => calls.loadTodo++,
    scheduleStatus: () => calls.scheduleStatus++,
    loadPermissions: () => calls.loadPermissions++,
    scheduleOther: () => calls.scheduleOther++,
    messagesRef: { current: [{ info: { id: "m1" }, parts: [] }] },
    stream: {
      apply: (prev) => [...prev, "applied"],
      hasPending: () => false,
    },
    commit: (next) => (deps.committed = next),
    scheduleFlush: () => calls.scheduleFlush++,
    ...over,
  };
  return { deps, calls };
}

test("session.idle: chốt running=false + nạp lại session/todo + nhịp status", () => {
  const { deps, calls } = makeDeps();
  const handle = createChatEventRouter(deps);
  handle("session.idle", { properties: { sessionID: "ses_1" } });
  assert.equal(deps.running, false);
  assert.equal(calls.loadSession, 1);
  assert.equal(calls.loadTodo, 1);
  assert.equal(calls.scheduleStatus, 1);
});

test("session.status: map không nhắc phiên = RẢNH (engine chỉ liệt kê đang chạy); shape lạ thì giữ", () => {
  const { deps } = makeDeps();
  const handle = createChatEventRouter(deps);
  deps.running = true;
  handle("session.status", { properties: { ses_1: { type: "busy" } } });
  assert.equal(deps.running, true);
  // Map rỗng: phiên không được liệt kê = đã rảnh — dập tắt busy là ĐÚNG.
  handle("session.status", { properties: {} });
  assert.equal(deps.running, false);
  // Shape lạ (type không phải string): đừng đoán — giữ trạng thái cũ.
  deps.running = "unchanged-marker";
  handle("session.status", { properties: { ses_1: "garbage" } });
  assert.equal(deps.running, "unchanged-marker");
});

test("message.part.delta: apply stream + commit + setRunning(true) + flush khi có pending", () => {
  const { deps, calls } = makeDeps();
  deps.stream.hasPending = () => true;
  const handle = createChatEventRouter(deps);
  handle("message.part.delta", { properties: { sessionID: "ses_1" } });
  assert.equal(deps.running, true);
  assert.deepEqual(deps.committed, [{ info: { id: "m1" }, parts: [] }, "applied"]);
  assert.equal(calls.scheduleStatus, 1);
  assert.equal(calls.scheduleFlush, 1);
});

test("permission.updated: chỉ nạp permission + nhịp phụ, không đụng transcript", () => {
  const { deps, calls } = makeDeps();
  const handle = createChatEventRouter(deps);
  handle("permission.updated", { properties: { sessionID: "ses_1" } });
  assert.equal(calls.loadPermissions, 1);
  assert.equal(calls.scheduleOther, 1);
  assert.equal(deps.committed, undefined);
  assert.equal(deps.running, undefined);
});

test("event của phiên khác + server.* + rác: bỏ qua, không commit không loader", () => {
  const { deps, calls } = makeDeps();
  const handle = createChatEventRouter(deps);
  handle("message.part.updated", { properties: { sessionID: "ses_OTHER" } });
  handle("server.connected", undefined);
  handle("server.heartbeat", { properties: {} });
  handle("message.updated", "không phải object");
  handle("message.updated", null);
  assert.equal(deps.committed, undefined);
  assert.equal(deps.running, undefined);
  assert.equal(calls.loadSession + calls.loadTodo + calls.loadPermissions + calls.scheduleStatus + calls.scheduleOther, 0);
});

test("event lạ (không phải 3 loại message.*): rẽ nhánh scheduleOther", () => {
  const { deps, calls } = makeDeps();
  const handle = createChatEventRouter(deps);
  handle("todo.updated", { properties: { sessionID: "ses_1" } });
  assert.equal(calls.scheduleOther, 1);
  assert.equal(calls.scheduleStatus, 0);
});
