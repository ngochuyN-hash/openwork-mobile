// Bảng điều phối SSE của màn chat — tách khỏi mega-effect của pages/chat.jsx
// (round 4, 09/10). Handler trước đây là closure 40 dòng trộn 12 thứ; giờ là
// một factory nhận deps (đều là ref-like {current} hoặc hàm) nên node --test
// chạy được với deps giả: event nào gọi loader nào, ai chốt running — ghim hết.
//
// Protocol (học từ desktop apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message
//  - message.removed:      message bị xoá/revert
//  - session.idle/errored: chốt run status NGAY, khỏi đợi poll
// Engine phát event KHÔNG TÊN trên SSE — type nằm trong JSON (lib/sse.js bóc).
import { eventProps, eventSessionId, sameSession } from "./chat-events.js";
import { sessionBusyFromMap } from "./session-steer.js";

/**
 * deps — mọi thứ handler chạm tới:
 *   sessionId        phiên đang mở (event của phiên khác bị bỏ)
 *   lastEventAt      ref {current} — mốc event cuối cho watchdog 30s
 *   setRunning       chốt trạng thái đang chạy
 *   loadSession/loadTodo/loadPermissions  loader nạp lại
 *   scheduleStatus   nhịp hỏi lại nhẹ (900ms)
 *   scheduleOther    nhịp hỏi lại phụ (500ms: permission + question)
 *   messagesRef      ref {current} transcript mới nhất
 *   stream           reducer lib/chat-stream ({apply, hasPending})
 *   commit           commitMessages của trang
 *   scheduleFlush    lịch đổ buffer delta theo frame
 */
export function createChatEventRouter(deps) {
  const {
    sessionId,
    lastEventAt,
    setRunning,
    loadSession,
    loadTodo,
    scheduleStatus,
    loadPermissions,
    scheduleOther,
    messagesRef,
    stream,
    commit,
    scheduleFlush,
  } = deps;

  return function handleEvent(name, data) {
    lastEventAt.current = Date.now();
    // Nhịp sống của kết nối, không mang dữ liệu phiên.
    if (name === "server.connected" || name === "server.heartbeat") return;
    if (!data || typeof data !== "object") return;
    if (!sameSession(eventSessionId(data), sessionId)) return;
    if (name === "session.idle" || name === "session.errored" || name === "session.status") {
      // Run kết thúc thật (idle/errored) hoặc status report — chốt ngay,
      // không chờ poll 2.5s. status mang map {ses: {type}} thì tự suy.
      const props = eventProps(data);
      const busy = name === "session.status" ? sessionBusyFromMap(props, sessionId) : false;
      if (name !== "session.status") setRunning(false);
      else if (busy !== undefined) setRunning(busy);
      // Run vừa kết thúc: session có thể vừa bị đổi (cost tăng, con trỏ
      // revert dọn), và todo vừa được chốt — nạp lại cho đúng.
      loadSession();
      loadTodo();
      scheduleStatus();
      return;
    }
    if (name === "permission.updated") {
      loadPermissions();
      scheduleOther();
      return;
    }
    const prev = messagesRef.current;
    const next = stream.apply(prev ?? [], data);
    if (next !== prev) commit(next);
    if (name === "message.part.updated" || name === "message.part.delta" || name === "message.updated") {
      setRunning(true); // vào guồng stream ngay, poll dự phòng bám theo
      scheduleStatus();
      if (stream.hasPending()) scheduleFlush();
    } else {
      scheduleOther();
    }
  };
}
