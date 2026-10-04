// Reducer stream chat — logic THUẦN, tách khỏi chat.jsx để test được
// (học desktop: session-sync là module thuần với hook __applyEventForTest).
//
// Protocol engine opencode (đọc từ source desktop apps/app session-sync.ts):
//  - message.part.updated: properties.part = snapshot CỘNG DỒN của một part
//    (chìa part.id) — upsert thay thế.
//  - message.part.delta:   properties.{partID,delta} = miếng chữ tăng dần của
//    part đó — gom vào buffer, caller flush theo frame (không render từng ký tự).
//  - message.updated:      properties.message = snapshot cả message.
//  - message.removed:      properties.messageID = message bị xoá/revert.
//
// Quy tắc chống nhân đôi bytes: buffer delta và snapshot là hai góc nhìn cộng
// dồn của cùng một stream — khi part.updated khai báo part, lấy cái DÀI HƠN
// chứ không nối.

/** Tìm chỉ số message theo id (shape engine: {info:{id},...} hoặc phẳng). */
function findMsgIndex(list, messageId) {
  return list.findIndex((m) => (m.info?.id ?? m.id) === messageId);
}

function idOfMessage(message) {
  return message?.info?.id ?? message?.id ?? "";
}

function roleOfMessage(message) {
  return message?.info?.role ?? message?.role;
}

/** Chữ của 1 message: nối mọi part text. */
function textOfMessage(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  let out = "";
  for (const p of parts) if (p?.type === "text" && typeof p.text === "string") out += p.text;
  return out.trim();
}

/**
 * Chữ dùng để KHỚP tin client tự sinh với bản thật engine trả về.
 *
 * Không dựa vào `time.created`: tin optimistic ghi `Date.now()` CỦA ĐIỆN THOẠI,
 * còn engine tự đóng dấu thời điểm nó nhận prompt — hai đồng hồ khác nhau,
 * trị tuyệt đối gần như không bao giờ bằng nhau. Khớp bằng thời điểm là khớp
 * không bao giờ trúng, nên bản optimistic sống mãi cạnh bản thật.
 *
 * `localSentText` là chữ THẬT sẽ gửi lên máy — khác với chữ hiện trên bong
 * bóng khi người dùng chỉ đính kèm file (bong bóng hiện "Đã gửi N file…").
 */
function localMatchText(message) {
  const sent = message?.info?.localSentText;
  if (typeof sent === "string" && sent.trim()) return sent.trim();
  return textOfMessage(message);
}

function isLocalUserMessage(message) {
  return isLocalMessageId(idOfMessage(message)) && roleOfMessage(message) === "user";
}

/**
 * Vị trí trong `list` của tin client tự sinh mà message vừa tới nối tiếp.
 *
 * Ưu tiên khớp theo CHỮ (chắc chắn đúng tin đó). Engine hay gửi
 * `message.updated` lúc mới tạo message với `parts` RỖNG — không có chữ để
 * so. Khi đó fallback theo THỨ TỰ: tin `local-*` cũ nhất chưa được ghép chính
 * là tin mà message mới nhất vừa xác nhận, vì engine ghi tin theo đúng thứ tự
 * người dùng gõ. Bỏ bản local đó (đã được xác nhận), KHÔNG bỏ bản local sau nó
 * (chưa tới máy) — bỏ nhầm là mất tin của người dùng.
 *
 * -1 = không có tin chờ nào khớp.
 */
function findLocalSpot(list, message) {
  if (roleOfMessage(message) !== "user") return -1;
  const text = textOfMessage(message);
  for (let i = 0; i < list.length; i += 1) {
    if (!isLocalUserMessage(list[i])) continue;
    if (text) {
      if (localMatchText(list[i]) !== text) continue;
      return i;
    }
    // Không có chữ để so: lấy bản local cũ nhất còn chờ.
    return i;
  }
  return -1;
}

/**
 * Bỏ tin client tự sinh nào đã có bản thật của engine.
 *
 * Một tin gửi từ điện thoại đi qua hai bước: dựng bản `local-*` để hiện ngay,
 * rồi SSE mang bản thật (messageID `msg_*`) về. Hai bước có thể tới theo
 * thứ tự nào cũng được — `message.updated` trước, hoặc `message.part.updated`
 * tạo stub trước rồi `message.updated` mới chốt role. Nếu chỉ xử lý một
 * đường, tin đó hiện HAI lần.
 *
 * Ghép hai bản bằng CHỮ (không phải `time.created` — xem `localMatchText`),
 * và ghép theo thứ tự: mỗi bản thật chỉ nhận một bản `local-*`, bản `local-*`
 * chỉ bị bỏ khi có bản thật nằm SAU nó. Tin vừa gửi mà engine chưa trả về
 * thì không có bản thật nào sau nó → giữ nguyên.
 */
function reconcileLocalUserMessages(list) {
  const locals = [];
  for (let i = 0; i < list.length; i += 1) if (isLocalUserMessage(list[i])) locals.push(i);
  if (!locals.length) return list; // đường nóng: không có tin tự sinh thì khỏi quét
  const used = new Set();
  const drop = new Set();
  for (const at of locals) {
    const text = localMatchText(list[at]);
    if (!text) continue;
    for (let i = at + 1; i < list.length; i += 1) {
      if (used.has(i)) continue;
      const candidate = list[i];
      if (roleOfMessage(candidate) !== "user") continue;
      if (textOfMessage(candidate) !== text) continue;
      used.add(i);
      drop.add(at);
      break;
    }
  }
  if (!drop.size) return list;
  return list.filter((_, i) => !drop.has(i));
}

/** Reducer stream cho 1 trang chat. `prev` là mảng messages hiện tại. */
export function createChatStream() {
  const pendingDelta = new Map();

  /** Delta tới trước snapshot (part chưa khai báo) — giữ chờ seed. */
  function queueDelta(partId, delta) {
    pendingDelta.set(partId, (pendingDelta.get(partId) ?? "") + delta);
  }

  /** part.updated: nhét snapshot cộng dồn theo part.id. Trả list mới. */
  function applyPartSnapshot(list, messageId, part) {
    if (!messageId || !part?.id) return { list, applied: false };
    const next = [...list];
    let idx = findMsgIndex(next, messageId);
    if (idx < 0) {
      // Part mới của message mới — stub assistant; role thật sẽ tới theo
      // message.updated (desktop: inferStubRole).
      next.push({ info: { id: messageId, role: "assistant" }, parts: [] });
      idx = next.length - 1;
    }
    const msg = next[idx];
    const parts = [...(msg.parts ?? [])];
    const pi = parts.findIndex((p) => p?.id === part.id);
    const buffered = pendingDelta.get(part.id) ?? "";
    const base = typeof part.text === "string" ? part.text : "";
    const text = base.length >= buffered.length ? base : buffered;
    pendingDelta.delete(part.id);
    const merged = { ...(pi >= 0 ? parts[pi] : {}), ...part, text };
    if (pi >= 0) parts[pi] = merged;
    else parts.push(merged);
    next[idx] = { ...msg, parts };
    return { list: next, applied: true };
  }

  /** Heuristic nối chữ — fallback part không có id (engine cũ/bản lạ). */
  function applyTextPatch(list, messageId, chunk) {
    if (!chunk) return list;
    const next = [...list];
    let idx = messageId ? findMsgIndex(next, messageId) : -1;
    if (idx < 0) {
      for (let i = next.length - 1; i >= 0; i--) {
        if ((next[i].info?.role ?? next[i].role) === "assistant") {
          idx = i;
          break;
        }
      }
    }
    if (idx < 0) {
      next.push({
        info: { id: messageId || "stream", role: "assistant" },
        parts: [{ type: "text", text: chunk }],
      });
      return next;
    }
    const msg = { ...next[idx], parts: [...(next[idx].parts ?? [])] };
    let pIdx = -1;
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i]?.type === "text") {
        pIdx = i;
        break;
      }
    }
    if (pIdx < 0) {
      msg.parts = [...msg.parts, { type: "text", text: chunk }];
    } else {
      const cur = msg.parts[pIdx]?.text ?? "";
      let text;
      if (!cur) text = chunk;
      else if (chunk.startsWith(cur)) text = chunk; // snapshot full
      else if (cur.endsWith(chunk)) text = cur; // event phát lại đuôi cũ
      else text = cur + chunk; // delta
      msg.parts[pIdx] = { ...msg.parts[pIdx], text };
    }
    next[idx] = msg;
    return next;
  }

  /** message.updated: upsert nguyên message (info + parts). */
  function applyMessageSnapshot(list, messageId, info, parts) {
    if (!messageId) return list;
    const next = [...list];
    const idx = findMsgIndex(next, messageId);
    const clean = Array.isArray(parts) ? parts.filter(Boolean) : [];
    if (idx < 0) {
      const message = { info: info ?? { id: messageId, role: "assistant" }, parts: clean };
      // Tin user vừa gửi từ điện thoại đã có sẵn một bản optimistic `local-*`
      // ở đúng chỗ này. Móc vào bản đó thay vì nối thêm — nếu không, mỗi tin
      // gửi đi đều bị hiện HAI lần (bản tự sinh + bản engine vừa trả).
      const spot = findLocalSpot(next, message);
      if (spot >= 0) {
        next[spot] = {
          ...message,
          // Engine chốt `parts` rỗng ở lúc tạm nghỉ — đừng để nó xoá chữ
          // optimistic đang hiện.
          parts: clean.length ? clean : next[spot].parts,
        };
        return next;
      }
      next.push(message);
      return next;
    }
    // Parts rỗng không đè phần đang stream — info thì cứ cập nhật.
    next[idx] = {
      ...next[idx],
      info: info ?? next[idx].info,
      parts: clean.length ? clean : next[idx].parts,
    };
    return next;
  }

  /** Áp 1 event (đã lọc session ở caller). Trả chính `prev` nếu không đổi —
   * caller dùng điều đó để bỏ qua render. */
  function apply(prev, data) {
    if (!data || typeof data !== "object") return prev;
    const type = data.type;
    const props = data.properties && typeof data.properties === "object" ? data.properties : data;
    if (type === "message.part.updated") {
      const part = props.part && typeof props.part === "object" ? props.part : props;
      const messageId =
        props.messageID ?? props.messageId ?? data.messageID ?? part?.messageID ?? "";
      const { list, applied } = applyPartSnapshot(prev, messageId, part);
      if (!applied) {
        // Part không có id — heuristic nối chữ.
        const chunk =
          (typeof part?.text === "string" && part.text) ||
          (typeof props?.delta === "string" && props.delta) ||
          "";
        return applyTextPatch(prev, messageId, chunk);
      }
      return reconcileLocalUserMessages(list);
    }
    if (type === "message.part.delta") {
      const partId = props.partID ?? props.partId ?? props.id;
      const delta = typeof props.delta === "string" ? props.delta : "";
      if (partId && delta) queueDelta(partId, delta);
      return prev; // buffer — render khi flush
    }
    if (type === "message.updated") {
      const message = data.message ?? props.message ?? null;
      if (!message) return prev;
      const id = message.id ?? message.info?.id ?? "";
      return reconcileLocalUserMessages(applyMessageSnapshot(prev, id, message.info, message.parts));
    }
    if (type === "message.removed") {
      const messageId = props.messageID ?? props.messageId ?? props.id;
      if (!messageId) return prev;
      return prev.filter((m) => (m.info?.id ?? m.id) !== messageId);
    }
    return prev;
  }

  /** Đổ buffer vào các part ĐÃ khai báo (gọi theo frame). Part chưa khai báo
   * giữ trong buffer đợi seed từ part.updated. */
  function flush(prev) {
    if (!pendingDelta.size || !prev) return prev;
    const list = prev.map((msg) => {
      let parts = null;
      (msg.parts ?? []).forEach((p, i) => {
        if (!p?.id) return;
        const add = pendingDelta.get(p.id);
        if (!add) return;
        if (!parts) parts = [...msg.parts];
        parts[i] = { ...p, text: (p.text ?? "") + add };
      });
      return parts ? { ...msg, parts } : msg;
    });
    const declared = new Set();
    for (const msg of prev) for (const p of msg.parts ?? []) if (p?.id) declared.add(p.id);
    for (const [partId] of [...pendingDelta]) {
      if (declared.has(partId)) pendingDelta.delete(partId);
    }
    return list;
  }

  return {
    apply,
    flush,
    hasPending: () => pendingDelta.size > 0,
    reset: () => pendingDelta.clear(),
  };
}

/** Id tin tự sinh phía client (đang hiện optimistically, chưa có id thật). */
export function isLocalMessageId(id) {
  return typeof id === "string" && id.startsWith("local-");
}

/**
 * Refetch full transcript giữa chừng run: API chỉ ghi nhận message ĐÃ xong
 * nên `fetched` thiếu message đang stream — thay nguyên list là trang co cụm,
 * scroll bị trình duyệt kẹp ngược lên (bug "cuộn xuống tự cuộn lên"). Giữ lại
 * message cục bộ mà fetched chưa có, đè lên vị trí cuối (message mới nhất).
 *
 * Riêng tin client tự sinh (`local-*`) thì phải BỎ khi server đã trả về bản
 * thật: id `local-<timestamp>` không bao giờ trùng `msg_*`, nên nếu giữ lại như
 * cũ thì mỗi lần refetch sẽ dồn thêm một bản — cùng nội dung hiện hai lần.
 *
 * Dấu hiệu server đã nhận: trong `fetched` đã có tin user cùng NỘI DUNG, đứng
 * sau bản `local-*` (xem `reconcileLocalUserMessages` — cùng lý do, cùng cách
 * ghép: so CHỮ chứ không so `time.created`, vì hai đồng hồ của máy và của
 * điện thoại không bao giờ khớp tuyệt đối).
 */
export function mergeRefetchKeepInflight(fetched, prev) {
  const list = Array.isArray(fetched) ? fetched : [];
  if (!Array.isArray(prev) || !prev.length) return list;
  const ids = new Set(list.map((m) => idOfMessage(m)));
  const prevIds = new Set(prev.map((m) => idOfMessage(m)));
  // CHỈ tin user mới xuất hiện trong `fetched` mới có thể xác nhận một bản
  // `local-*`. Tin đã có trong `prev` thì đã nằm đó từ trước khi người dùng
  // bấm Gửi — nó không thể là tin xác nhận cho tin mới.
  //
  // Không có chốt này thì lịch sử nuốt mất tin vừa gửi: người dùng gõ "ok",
  // lịch sử đã có "ok" từ 20 lượt trước, bấm Gửi, một lượt refetch (SSE
  // reconnect / tab focus) là tin vừa gửi biến mất khỏi màn hình.
  const realUserTexts = new Map();
  for (const m of list) {
    if (prevIds.has(idOfMessage(m))) continue; // đã có sẵn ở lượt trước
    if (roleOfMessage(m) !== "user") continue;
    const text = textOfMessage(m);
    if (!text) continue;
    realUserTexts.set(text, (realUserTexts.get(text) ?? 0) + 1);
  }
  const inflight = [];
  for (const m of prev) {
    const id = idOfMessage(m);
    if (ids.has(id)) continue; // server đã có bản thật (id trùng)
    if (!isLocalMessageId(id)) {
      inflight.push(m); // đang stream: phải giữ
      continue;
    }
    const text = localMatchText(m);
    const left = text ? realUserTexts.get(text) ?? 0 : 0;
    if (left > 0) {
      realUserTexts.set(text, left - 1); // bản local này đã có bản thật
      continue;
    }
    inflight.push(m); // engine chưa trả bản thật: giữ để không trắng màn
  }
  return inflight.length ? [...list, ...inflight] : list;
}
