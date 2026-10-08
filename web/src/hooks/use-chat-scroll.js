// Cuộn màn chat: đo vị trí người dùng, bám đáy khi stream, đếm tin mới khi họ
// đang đọc lịch sử. Quyết định "cuộn không / cuộn kiểu nào" và đếm tin mới nằm ở
// lib/chat-scroll.js (thuần, có test) — hook này chỉ đo vị trí và gọi.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  distanceFromBottom, isAtBottom, keepsAutoScroll, leftBottomBy, newMessagesSince, scrollPlan,
} from "../lib/chat-scroll.js";

/** Người dùng bảo không động đấy thì cuộn tức thì (luật skill: tôn trọng
 * prefers-reduced-motion). matchMedia có thể vắng ở môi trường test. */
function motionAllowed() {
  try {
    return typeof window?.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * Cuộn tới đáy MÀN (không phải tới `<div>` neo trong transcript).
 *
 * Màn chat cuộn trên window, composer là phần tử sticky nằm CUỐI trang — nên
 * "đáy" chính là cuộn hết document. Cuộn theo neo trong transcript thì neo đó
 * nằm TRÊN composer, màn cuộn tới đó thì composer (sticky) đè lên đuôi tin.
 */
function scrollChatToBottom(plan = "smooth") {
  if (typeof window === "undefined") return;
  const behavior = plan === "instant" || !motionAllowed() ? "auto" : "smooth";
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

/**
 * @param {{wsId: string, sessionId: string, messages: unknown[] | null}} args
 * @returns {{
 *   atBottom: boolean,
 *   unseen: number,
 *   jumpToLatest: () => void,
 *   markTranscriptLoaded: () => void,
 * }}
 *   `markTranscriptLoaded` — gọi khi transcript THẬT của phiên về (xem
 *   `transcriptRef`).
 */
export function useChatScroll({ wsId, sessionId, messages }) {
  // ---- Vị trí cuộn của người dùng ----
  // `atBottomRef` là vị trí THẬT, đo ở nhịp scroll — tức là TRƯỚC nhịp render kế
  // tiếp. Nhờ vậy một khối text/tool dài hơn ngưỡng cũ không làm auto-follow bỏ
  // (xem giải thích ở lib/chat-scroll.js).
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true); // để dựng/ẩn nút "về đáy"
  const unseenRef = useRef(0);
  const [unseen, setUnseen] = useState(0); // số tin mới tới khi người dùng đang đọc lịch sử
  const prevMessagesRef = useRef(null); // transcript lần render trước (đếm tin mới)
  // Đổi session = phải nhảy tới đáy phiên mới; vị trí cuộn của phiên cũ không
  // có ý nghĩa gì ở đây. Cờ này được effect [messages] tiêu thụ một lần.
  const forceBottomRef = useRef(true);
  // Transcript THẬT của phiên đã về chưa. Cờ `forced` chỉ được tiêu khi cờ này
  // bật — nếu không, một tin rác do SSE dựng sẵn (stub cho message chưa từng
  // thấy) có thể nuốt cờ, và lúc transcript thật về ta chỉ còn lệnh smooth từ
  // trên xuống: vào phiên dài lại thày một cuộn lết dài vài giây.
  const transcriptRef = useRef(false);
  // Vòng "bám lại đáy" chạy nhiều nhịp (nội dung còn đang lớn thêm sau khi
  // transcript về). Rời trang rồi mà nó còn chạy thì SANG TRANG KHÁC cũng bị
  // cuộn — nên hỏi cờ sống này trước mỗi nhịp.
  const aliveRef = useRef(true);
  const settleTimerRef = useRef(null);
  // Đang cuộn bằng lệnh của app (mở phiên / bấm nút) — cho phép bỏ qua vị trí
  // giữa đường, xem `measure`.
  const autoScrollRef = useRef(false);
  const lastYRef = useRef(0);

  const markTranscriptLoaded = useCallback(() => {
    transcriptRef.current = true;
  }, []);

  useEffect(() => {
    // Vào phiên mới: vị trí cuộn, cờ bám đáy và đếm tin mới của phiên trước
    // không có ý nghĩa ở đây.
    forceBottomRef.current = true;
    transcriptRef.current = false;
    atBottomRef.current = true;
    unseenRef.current = 0;
    prevMessagesRef.current = null;
    aliveRef.current = true;
    autoScrollRef.current = false;
    lastYRef.current = typeof window === "undefined" ? 0 : window.scrollY;
    setAtBottom(true);
    setUnseen(0);

    // ---- Đo vị trí cuộn: nghe `scroll` (passive), chỉ báo lại khi CỜ đổi ----
    // Đo ở đây tức là đo TRƯỚC nhịp render kế tiếp, nên "đang bám đáy" là vị trí
    // thật của người dùng chứ không phải phép đo sau khi tin mới đã dài ra.
    let scrollTick = null;
    const cancelTick = () => {
      if (scrollTick == null) return;
      (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(scrollTick);
      scrollTick = null;
    };
    const measure = () => {
      scrollTick = null;
      const y = window.scrollY;
      const gap = distanceFromBottom({
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollY: y,
      });
      // Hai quyết định, đều thuộc về lib/chat-scroll.js (có test):
      //   1. Còn cuộn bằng lệnh của app không? Nếu không hỏi, chính lệnh cuộn
      //      của ta bị đọc thành "người dùng đang lướt lên" và tự cuộn chết
      //      giữa lúc stream — bug lớn nhất của màn này.
      //   2. Người dùng đã rời đáy chưa? Vuốt lên là động cửa "cho tôi đọc
      //      lịch sử" nên phải rời vùng bám NGAY, không chờ vượt 260px — nếu
      //      không, lúc agent đang stream thì gần như không lướt lên nổi, và
      //      nút "về tin mới nhất" mất hết ý nghĩa đúng lúc cần nhất.
      const movedUp = y < lastYRef.current - 4;
      if (!keepsAutoScroll({ autoScroll: autoScrollRef.current, gap, movedUp })) {
        autoScrollRef.current = false;
      }
      lastYRef.current = y;
      const now =
        autoScrollRef.current
          ? true
          : !leftBottomBy({ autoScroll: false, gap, movedUp });
      if (now === atBottomRef.current) return; // không đổi cờ thì khỏi render lại
      atBottomRef.current = now;
      setAtBottom(now);
      if (now && unseenRef.current) {
        unseenRef.current = 0;
        setUnseen(0);
      }
    };
    const onScroll = () => {
      if (scrollTick != null) return;
      scrollTick =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(measure)
          : setTimeout(measure, 60);
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      aliveRef.current = false;
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
      cancelTick();
      window.removeEventListener("scroll", onScroll);
    };
  }, [wsId, sessionId]);

  /** Bám đáy thêm vài nhịp (tối đa ~0.7s) cho tới khi chạm đáy hoặc người dùng
   *  chạm cuộn. Một lần `scrollChatToBottom` là chưa chắc đủ: transcript vừa
   *  nạp còn nội dung cao thêm sau đó (stream tiếp, fold mở, ảnh nạp). */
  function settleToBottom(plan = "instant") {
    let tries = 0;
    autoScrollRef.current = true;
    const step = () => {
      tries += 1;
      // Hết lượt thì TRẢ LẠI quyền đo — nếu giữ cờ "đang cuộn tự động" mãi thì
      // `measure` cứ tưởng người dùng còn ở đáy và nút "về đáy" không bao giờ hiện.
      if (!aliveRef.current || tries > 6) {
        autoScrollRef.current = false;
        return;
      }
      // Người dùng kéo ngược lên giữa chừng → `measure` đã thả quyền, thôi.
      if (!autoScrollRef.current) return;
      const gap = distanceFromBottom({
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollY: window.scrollY,
      });
      if (isAtBottom(gap, 4)) {
        autoScrollRef.current = false;
        return;
      }
      scrollChatToBottom(plan);
      settleTimerRef.current = setTimeout(step, 120);
    };
    clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(step, 120);
  }

  useEffect(() => {
    if (messages === null) return;
    // Quyết định cuộn nằm ở lib/chat-scroll.js. Ba nhánh:
    //   "instant" — lần đầu vào phiên: nhảy tới đáy NGAY, không smooth. Đây là
    //               fix của bug mở phiên dài ra tin cũ nhất (đo gap sau render thì
    //               scrollY=0 + scrollHeight dài => cứ tưởng đang ở lịch sử).
    //   "smooth"  — đang bám đáy thì bám tiếp, kể cả khối mới dài hơn ngưỡng.
    //   "hold"    — người dùng đang lướt lên đọc: không giật, nhưng đếm tin mới.
    // Cờ "mở phiên thì phải tới đáy" chỉ được tiêu khi transcript THẬT về. Một
    // commit SSE stub (message chưa từng thấy, app tự dựng) không phải hồi
    // trọn phiên — tiêu cờ ở đó là mở phiên dài thành một lượt cuộn smooth lết
    // từ trên xuống, đúng cái lỗi ta đang sửa.
    const forced = forceBottomRef.current && transcriptRef.current;
    if (forced) forceBottomRef.current = false;
    const plan = scrollPlan({ forced, atBottom: atBottomRef.current });
    const prev = prevMessagesRef.current;
    prevMessagesRef.current = messages;
    if (plan === "hold") {
      const added = newMessagesSince(prev, messages);
      if (added > 0) {
        unseenRef.current += added;
        setUnseen(unseenRef.current);
      }
      return;
    }
    // MỌI lệnh cuộn của app đều phải bật cờ "đang cuộn tự động" — kể cả nhánh
    // smooth lúc stream. Thiếu bước này thì chính lệnh cuộn của ta làm đổi cờ
    // "đang bám đáy": smooth scroll còn đang chạy thì gap tạm thời lớn hơn
    // ngưỡng, `measure` kết luận người dùng đã lướt lên, và nhịp stream kế
    // tiếp rơi vào nhánh "hold" — tự cuộn chết giữa chừng, đúng cái lỗi mà
    // bản này sinh ra để chữa.
    autoScrollRef.current = true;
    scrollChatToBottom(plan);
    // Transcript vừa nạp: chiều cao trang còn đang lớn thêm (ảnh, khối fold mở
    // ra). Bám lại vài nhịp cho chắc — nhưng dừng ngay khi người dùng chạm
    // cuộn, không giành quyền cuộn của họ.
    if (forced) settleToBottom();
  }, [messages]);

  // ---- Về tin mới nhất: đường về đáy khi đang đọc lịch sử ----
  function jumpToLatest() {
    unseenRef.current = 0;
    setUnseen(0);
    lastYRef.current = window.scrollY;
    scrollChatToBottom("smooth");
    settleToBottom("smooth");
  }

  return { atBottom, unseen, jumpToLatest, markTranscriptLoaded };
}
