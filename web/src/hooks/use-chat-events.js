// Luồng sự kiện thời gian thực của màn chat: SSE (lib/sse.js) → reducer part
// (lib/chat-stream.js) → commit theo frame, cùng nhịp hỏi lại dự phòng khi
// stream im (poll status, watchdog, refetch khi tab/mạng trở lại).
import { useEffect, useRef } from "preact/hooks";
import { connectEvents } from "../lib/sse.js";
import { createChatStream } from "../lib/chat-stream.js";
import { eventSessionId, sameSession, eventProps } from "../lib/chat-events.js";
import { sessionBusyFromMap } from "../lib/session-steer.js";

// Protocol event học từ desktop (apps/app session-sync.ts):
//  - message.part.updated: snapshot cộng dồn của MỘT part (chìa part.id)
//  - message.part.delta:   miếng chữ tăng dần của part đó (engine v2)
//  - message.updated:      snapshot cả message (info + parts)
//  - message.removed:      message bị xoá/revert — gọt khỏi transcript
//  - session.idle/errored: chốt run status ngay, khỏi đợi poll
// Engine opencode phát event KHÔNG TÊN trên SSE — type nằm trong JSON.

/**
 * @param {{
 *   wsId: string,
 *   sessionId: string,
 *   base: string,
 *   running: boolean,
 *   runningRef: {current: boolean},
 *   messagesRef: {current: unknown[] | null},
 *   commitMessages: (next: unknown[] | null) => void,
 *   setRunning: (running: boolean) => void,
 *   loadSession: () => unknown,
 *   loadMessages: () => unknown,
 *   loadStatus: () => unknown,
 *   loadPermissions: () => unknown,
 *   loadQuestions: () => unknown,
 *   loadTodo: () => unknown,
 *   flushQueue: () => unknown,
 * }} args
 */
export function useChatEvents({
  wsId, sessionId, base, running, runningRef, messagesRef, commitMessages, setRunning,
  loadSession, loadMessages, loadStatus, loadPermissions, loadQuestions, loadTodo, flushQueue,
}) {
  // Mốc event SSE cuối + trạng thái running cho watchdog/poll dự phòng.
  const lastEventAt = useRef(Date.now());
  // Reducer stream (lib/chat-stream.js — thuần, có test) + lịch flush theo
  // frame: gom delta rồi đổ một lần, không re-render từng ký tự.
  const streamRef = useRef(null);
  if (!streamRef.current) streamRef.current = createChatStream();
  const flushRef = useRef(null);

  useEffect(() => {
    // ---- Streaming theo PART: reducer thuần ở lib/chat-stream.js ----
    // Không còn "đoán snapshot hay delta" trên một chuỗi text chung — chìa là
    // part.id; delta gom vào buffer rồi flush theo frame.
    const scheduleFlush = () => {
      if (flushRef.current != null) return;
      const run = () => {
        flushRef.current = null;
        const prev = messagesRef.current;
        if (prev) commitMessages(streamRef.current.flush(prev));
      };
      // Foreground flush theo frame như desktop; không rAF thì 50ms.
      flushRef.current =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(run)
          : setTimeout(run, 50);
    };

    // Nhịp hỏi lại: event part đã là dữ liệu thật nên KHÔNG refetch full
    // nữa (trước đây mỗi ~900ms fetch lại toàn bộ transcript) — chỉ đồng
    // bộ run-status nhẹ. Refetch full chỉ còn: mount, reconnect, tab trở
    // lại, watchdog 30s.
    let statusTimer = null;
    let otherTimer = null;
    const scheduleStatus = () => {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => loadStatus(), 900);
    };
    const scheduleOther = () => {
      clearTimeout(otherTimer);
      otherTimer = setTimeout(() => {
        loadStatus();
        loadPermissions();
        loadQuestions();
      }, 500);
    };

    // Hạt nhân dispatch — type lấy từ JSON trong dòng `data:` (lib/sse.js bóc
    // sẵn). Engine phát event không tên nên đây là đường chính.
    const handleEvent = (name, data) => {
      lastEventAt.current = Date.now();
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
      const next = streamRef.current.apply(prev ?? [], data);
      if (next !== prev) commitMessages(next);
      if (name === "message.part.updated" || name === "message.part.delta" || name === "message.updated") {
        setRunning(true); // vào guồng stream ngay, poll dự phòng bám theo
        scheduleStatus();
        if (streamRef.current.hasPending()) scheduleFlush();
      } else {
        scheduleOther();
      }
    };
    // Stream qua fetch (lib/sse.js): token đi bằng header Authorization, không
    // phải `?_t=` trên URL, và đứt là tự nối lại với backoff.
    const stopEvents = connectEvents(`/api/ow${base}/event`, handleEvent, {
      onOpen: () => {
        lastEventAt.current = Date.now();
        flushQueue();
      },
      onLost: () => {
        // Stream đứt (tunnel đổi, mobile ngủ, server restart) — refetch full
        // ngay để không đứng hình chờ event kế tiếp.
        loadMessages();
        loadStatus();
      },
    });
    const refetchVisible = () => {
      if (document.visibilityState === "visible") {
        lastEventAt.current = Date.now();
        loadMessages();
        loadStatus();
      }
    };
    const onOnline = () => {
      lastEventAt.current = Date.now();
      flushQueue();
    };
    document.addEventListener("visibilitychange", refetchVisible);
    window.addEventListener("focus", refetchVisible);
    window.addEventListener("online", onOnline);

    return () => {
      clearTimeout(statusTimer);
      clearTimeout(otherTimer);
      if (flushRef.current != null) {
        (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(flushRef.current);
        flushRef.current = null;
      }
      streamRef.current.reset();
      stopEvents();
      document.removeEventListener("visibilitychange", refetchVisible);
      window.removeEventListener("focus", refetchVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [wsId, sessionId, commitMessages]);

  // Poll dự phòng khi agent chạy: chỉ loadStatus (2.5s) — nội dung chữ đến
  // qua stream, không refetch transcript mỗi nhịp nữa. Watchdog 30s không
  // thấy event nào mà vẫn running thì refetch full một lần (kênh chết ngầm).
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => {
      loadStatus();
    }, 2500);
    const watch = setInterval(() => {
      if (runningRef.current && Date.now() - lastEventAt.current > 30_000) {
        lastEventAt.current = Date.now();
        loadMessages();
        loadStatus();
      }
    }, 10_000);
    return () => {
      clearInterval(poll);
      clearInterval(watch);
    };
  }, [running, wsId, sessionId, loadMessages, loadStatus]);
}
