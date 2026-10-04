import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ow, unwrap, timeAgo } from "../api.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList } from "../components/ui.jsx";
import { SearchIcon } from "../components/icons.jsx";
import { wsColor } from "./home.jsx"; // màu nhận diện workspace, cùng hàm home dùng
import {
  normalizeQuery, searchSessions, sessionContentText, scanPlan, mapLimit,
} from "../lib/session-search.js";
import { mergeContents, scanState } from "../lib/search-scan.js";

// Tìm phiên theo TÊN và theo NỘI DUNG hội thoại — desktop có một ô như vậy.
// Chấm trong nội dung tốn mạn: mỗi phiên là MỘT request transcript riêng
// (GET /opencode/session/:sid/message, xem chat.jsx), nên chỉ quét N phiên vừa
// sửa mỗi lần gõ, đồng thời 3 request; nội dung đã tải thì giữ lại nên gõ tiếp
// không phải tải lại. Cái gì chưa quét thì nói thẳng với người dùng (hint
// dưới ô tìm), đừng im lặng ra một danh sách "đầy đủ" nhưng thiếu.
const SCAN_LIMIT = 12;
const SCAN_CONCURRENCY = 3;
const RESULT_LIMIT = 40;
const WS_LIMIT = 8; // không quét workspace: quét 8 workspace gần nhất, y hệt home.jsx

export function SearchPage({ route }) {
  // wsId rỗng = tìm trên MỌI workspace (không có workspace thì ngõ này không mở).
  const wsId = route?.wsId ?? "";
  const [rows, setRows] = useState(null); // [{...session, wsId, wsName}]
  const [contents, setContents] = useState({}); // {sessionId: text đã lọc}
  const [scanned, setScanned] = useState(0); // số phiên đã quét xong nội dung
  const [scanning, setScanning] = useState(0); // số phiên đang tải
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState("");
  const contentsRef = useRef(contents);
  contentsRef.current = contents;
  // FALSE khi component đã bị bỏ khỏi cây. Tách khỏi `cancelled` của effect quét:
  // `cancelled` bật lên mỗi khi deps đổi (đổi từ khoá) và ĐÚNG LÚC ĐÓ ta vẫn
  // muốn giữ transcript đã tải xong — bỏ nó đi thì gõ tiếp là tải lại đúng
  // những cái vừa tải. Chỉ `unmounted` mới được chặn setState.
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

  // Chống race khi đổi workspace / bấm "Tải lại": `load` cũ quay về sau sẽ
  // setRows và vẽ danh sách của workspace CŨ dưới tiêu đề mới. Không có seq
  // thì bấm hai workspace liên tiếp là danh sách nhảy lung tung.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      let scopes = [{ id: wsId, name: "" }];
      if (!wsId) {
        const payload = await ow("/workspaces");
        if (seq !== loadSeq.current) return;
        const list = unwrap(payload)?.workspaces ?? payload?.workspaces ?? [];
        scopes = list.slice(0, WS_LIMIT).map((ws) => ({
          id: ws.id,
          name: ws.name || ws.displayName || ws.id,
        }));
      }
      const groups = await Promise.all(
        scopes.map((sc) =>
          ow(`/workspace/${encodeURIComponent(sc.id)}/opencode/session`)
            .then((p) => (unwrap(p) ?? []).map((s) => ({ ...s, wsId: sc.id, wsName: sc.name })))
            // Workspace hỏng/riêng tư: bỏ riêng nó, còn workspace khác vẫn tìm được
            .catch(() => [])
        )
      );
      if (seq !== loadSeq.current) return;
      setRows(groups.flat());
      setError("");
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(String(e.message || e));
      setRows([]);
    }
  }, [wsId]);

  useEffect(() => {
    // Đổi workspace thì bỏ cache nội dung cũ (nội dung thuộc session của
    // workspace trước, giữ lại chỉ tốn RAM và làm kết quả sai chỗ).
    setContents({});
    contentsRef.current = {};
    setScanned(0);
    setScanning(0);
    load();
  }, [load]);

  // Gõ kiểu tiếng Việt có dấu chuyển chữ (composing) — chờ 250ms yên ổn rồi
  // mới tìm, tránh mỗi ký tự lại quét một đợt. Xoá ô tìm cũng phải chờ 250ms
  // mới tắt trạng thái quét — dùng `normalizeQuery("")` -> "" ở đây.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(normalizeQuery(query)), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Khoá theo `wsId:id` — `id` phiên chỉ là duy nhất TRONG MỘT engine, còn
  // trang này tìm được trên tới 8 workspace (mỗi workspace một engine riêng).
  // Bản cũ khoá chỉ bằng `id` nên phiên trùng id ở workspace thứ hai làm mất
  // tên workspace trên nhãn.
  const byId = useMemo(
    () => new Map((rows ?? []).map((r) => [`${r.wsId}:${r.id}`, r])),
    [rows]
  );

  // ID hợp lệ của phạm vi tìm HIỆN TẠI — chặn kết quả quét của lượt cũ (đã
  // huỷ) hoặc của workspace trước lọt vào `contents` khi người dùng đổi
  // workspace giữa chừng. Xem mergeContents.
  const allowedIds = useMemo(() => new Set((rows ?? []).map((r) => String(r.id))), [rows]);

  // Quét nội dung các phiên chưa có trong cache. Chạy lại mỗi khi đổi từ khoá
  // hoặc danh sách phiên mới tải về; `contents` KHÔNG nằm trong deps (setState
  // nó sẽ quay lại effect này → lặp vô hạn), effect đọc qua ref.
  //
  // KHÔNG dùng cờ `cancelled` kiểu "bỏ kết quả lượt cũ" như bản cũ: transcript
  // đã tải xong vẫn đúng cho workspace hiện tại, bỏ đi chỉ là tải lại. Thay
  // vào đó `scanToken` đánh dấu lượt MỚI NHẤT — lượt cũ vẫn ghi cache (lọc
  // theo `allowedIds`) nhưng không được tắt cờ `scanning` của lượt đang chạy.
  const scanToken = useRef(null);
  useEffect(() => {
    if (!debounced || !rows?.length) {
      // Không có gì để quét -> PHẢI tắt cờ. Bản cũ return thẳng, `scanning` đứng
      // ở số của lượt trước và dòng hint kẹt "đang quét N phiên" vĩnh viễn.
      scanToken.current = null;
      setScanning(0);
      return undefined;
    }
    const plan = scanPlan(rows, contentsRef.current, SCAN_LIMIT);
    if (!plan.length) {
      scanToken.current = null;
      setScanning(0);
      return undefined;
    }
    const token = {};
    scanToken.current = token;
    setScanning(plan.length);
    // `scanPlan` trả về id trần (không kèm wsId) — tra lại để biết phiên đó
    // thuộc workspace nào, tránh đoán mò rồi gọi nhầm `/workspace//session/...`.
    const itemOf = new Map((rows ?? []).map((r) => [String(r.id), r]));
    mapLimit(plan, SCAN_CONCURRENCY, async (sid) => {
      const item = itemOf.get(sid);
      try {
        const payload = await ow(
          `/workspace/${encodeURIComponent(item?.wsId ?? "")}/opencode/session/${encodeURIComponent(sid)}/message`
        );
        return { sid, text: sessionContentText(unwrap(payload) ?? []) };
      } catch {
        // Phiên vừa bị xoá lúc đang quét: coi như rỗng, đừng làm hỏng cả trang.
        return { sid, text: "" };
      }
    }).then((fetched) => {
      const got = fetched.filter(Boolean);
      // Cache nội dung: mergeContents lọc theo allowedIds nên kết quả của
      // workspace trước (đổi workspace giữa lúc đang quét) bị loại, còn của
      // workspace hiện tại thì giữ lại dù lượt này đã bị thay.
      const next = mergeContents(contentsRef.current, got, allowedIds);
      contentsRef.current = next;
      if (unmounted.current) return;
      setContents(next);
      // Chỉ lượt MỚI NHẤT được đếm `scanned` và tắt `scanning`: lượt cũ có thể
      // quét TRÙNG các phiên lượt mới đang quét (scanPlan chạy lúc cache còn
      // rỗng), đếm lại là dòng "đã quét X/Y" nhảy vượt quá tổng số phiên.
      if (scanToken.current !== token) return;
      setScanned((n) => n + got.length);
      setScanning(0);
    });
    return undefined;
  }, [debounced, rows, allowedIds]);

  const results = useMemo(
    () => (rows && debounced ? searchSessions(rows, debounced, { contents, limit: RESULT_LIMIT }) : []),
    [rows, debounced, contents]
  );

  function open(session) {
    navigate(`#/ws/${encodeURIComponent(session.wsId)}/chat/${encodeURIComponent(session.id)}`);
  }

  // Trạng thái + dòng hint + nhánh <Empty> gói trong MỌT hàm (lib/search-scan)
  // để chúng không thể lệch nhau. `results` khi chưa gõ luôn có phần tử (xem
  // searchSessions) nên `results.map` phải chặn theo `phase`.
  const phase = useMemo(
    () =>
      scanState({
        debounced,
        resultCount: results.length,
        scanning,
        scanned,
        totalSessions: rows?.length ?? 0,
      }),
    [debounced, results.length, scanning, scanned, rows?.length]
  );

  return (
    <>
      {/* Ô tìm: dùng lại đúng hàng ô của model-picker (styles.css chưa có class
          ô tìm riêng), chữ 16px sẵn trong class nên iOS không zoom khi focus. */}
      <div class="model-search">
        <SearchIcon size={16} />
        <input
          type="search"
          value={query}
          placeholder={wsId ? "Tìm trong workspace này…" : "Tìm trên mọi phiên…"}
          aria-label="Tìm phiên theo tên và nội dung"
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      <div class="page-head">
        <span class="hint" aria-live="polite">{phase.hint}</span>
        <button type="button" class="btn small ghost" onClick={load}>Tải lại</button>
      </div>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={load}>{error}</Banner>}

      {rows === null && !error && <SkeletonList rows={3} />}

      {rows !== null && phase.phase === "idle" && (
        <Empty
          icon={SearchIcon}
          title="Tìm phiên nào đó?"
          hint="Gõ tên phiên, hoặc một cụm từ nằm trong hội thoại. Kết quả khớp tên luôn đứng trước."
        />
      )}

      {rows !== null && phase.phase === "scanning" && (
        <Empty icon={SearchIcon} title="Chưa thấy phiên nào khớp ở tên" hint={phase.hintText} />
      )}

      {rows !== null && phase.phase === "empty" && (
        <Empty icon={SearchIcon} title={`Không tìm thấy “${debounced.trim()}”`} hint={phase.hintText} />
      )}

      {/* Chỉ vẽ danh sách khi phase = "none" (có kết quả). `searchSessions` với
          từ khoá rỗng trả về MỌI phiên (xem JSDoc của nó), nên render thẳng
          `results.map` mà không chặn sẽ hiện danh sách phiên NGAY DƯỚI ô
          "Tìm phiên nào đó?" — hai thứ mâu thuẫn trên cùng một màn hình. */}
      {phase.phase === "none" && results.map((r) => {
        // `byId` khoá theo id phiên, KHÔNG khoá theo workspace: hai workspace
        // (hai engine riêng) sinh id trùng nhau là bản đồ ghi đè, và
        // `open(item)` sẽ nhảy sang workspace của phiên trùng id kia. `r` đã
        // mang wsId đúng của nó nên điều hướng dùng `r`; `item` chỉ để lấy
        // tên workspace cho nhãn.
        const item = byId.get(`${r.wsId}:${r.id}`);
        return (
          <div
            key={`${r.wsId}:${r.id}`}
            class="card tap"
            role="button"
            tabIndex={0}
            onClick={() => open(r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open(r);
              }
            }}
          >
            <div class="row-between">
              <h3>{r.title}</h3>
              <span class={`badge ${r.matchIn === "title" ? "ok" : ""}`}>
                {r.matchIn === "title" ? "khớp tên" : "khớp nội dung"}
              </span>
            </div>
            {r.snippet && (
              // `r.snippet` là TEXT thuần render bằng JSX nên Preact escape —
              // không có đường chèn HTML. Đoạn trích dài không đẩy danh sách
              // ra khỏi màn hình nhờ `cmd-desc` chặn 2 dòng sẵn có.
              <div class="cmd-desc" style="margin-top:6px">{r.snippet}</div>
            )}
            <div class="row-between" style="margin-top:6px">
              {!wsId && (
                <span class="ws-chip" style={`--ws-c:${wsColor(r.wsId)}`}>
                  <span class="ws-dot" style={`background:${wsColor(r.wsId)}`} aria-hidden="true" />
                  <span class="ws-name">{item?.wsName || r.wsId}</span>
                </span>
              )}
              <span class="hint">{timeAgo(r.updatedAt)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
