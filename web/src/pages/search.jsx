import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ow, unwrap, timeAgo } from "../api.js";
import { navigate } from "../app.jsx";
import { Banner, Empty, SkeletonList } from "../components/ui.jsx";
import { SearchIcon } from "../components/icons.jsx";
import { wsColor } from "./home.jsx"; // màu nhận diện workspace, cùng hàm home dùng
import {
  normalizeQuery, searchSessions, sessionContentText, scanPlan, mapLimit,
} from "../lib/session-search.js";

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

  const load = useCallback(async () => {
    try {
      let scopes = [{ id: wsId, name: "" }];
      if (!wsId) {
        const payload = await ow("/workspaces");
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
      setRows(groups.flat());
      setError("");
    } catch (e) {
      setError(String(e.message || e));
      setRows([]);
    }
  }, [wsId]);

  useEffect(() => {
    // Đổi workspace thì bỏ cache nội dung cũ (nội dung thuộc session của
    // workspace trước, giữ lại chỉ tốn RAM và làm kết quả sai chỗ).
    setContents({});
    setScanned(0);
    setScanning(0);
    load();
  }, [load]);

  // Gõ kiểu tiếng Việt có dấu chuyển chữ (composing) — chờ 250ms yên ổn rồi
  // mới tìm, tránh mỗi ký tự lại quét một đợt.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(normalizeQuery(query)), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const byId = useMemo(
    () => new Map((rows ?? []).map((r) => [String(r.id), r])),
    [rows]
  );

  // Quét nội dung các phiên chưa có trong cache. Chạy lại mỗi khi đổi từ khoá
  // hoặc danh sách phiên mới tải về; `contents` KHÔNG nằm trong deps (setState
  // nó sẽ quay lại effect này → lặp vô hạn), effect đọc qua ref.
  useEffect(() => {
    if (!debounced || !rows?.length) return;
    const plan = scanPlan(rows, contentsRef.current, SCAN_LIMIT);
    if (!plan.length) return;
    let cancelled = false;
    setScanning(plan.length);
    mapLimit(plan, SCAN_CONCURRENCY, async (sid) => {
      const item = byId.get(sid);
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
      if (cancelled) return;
      const next = { ...contentsRef.current };
      for (const f of fetched) if (f) next[f.sid] = f.text;
      contentsRef.current = next;
      setContents(next);
      setScanned((n) => n + fetched.filter(Boolean).length);
      setScanning(0);
    });
    return () => {
      cancelled = true;
    };
  }, [debounced, rows, byId]);

  const results = useMemo(
    () => (rows ? searchSessions(rows, debounced, { contents, limit: RESULT_LIMIT }) : []),
    [rows, debounced, contents]
  );

  function open(session) {
    navigate(`#/ws/${encodeURIComponent(session.wsId)}/chat/${encodeURIComponent(session.id)}`);
  }

  const hint = !debounced
    ? rows?.length
      ? `${rows.length} phiên sẵn sàng tìm`
      : "…"
    : `${results.length} kết quả${
        scanning ? ` · đang quét ${scanning} phiên` : scanned ? ` · đã quét nội dung ${scanned} phiên` : ""
      }`;

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
        <span class="hint" aria-live="polite">{hint}</span>
        <button class="btn small ghost" onClick={load}>Tải lại</button>
      </div>

      {error && <Banner kind="err" actionLabel="Thử lại" onAction={load}>{error}</Banner>}

      {rows === null && !error && <SkeletonList rows={3} />}

      {rows !== null && !debounced && (
        <Empty
          icon={SearchIcon}
          title="Tìm phiên nào đó?"
          hint="Gõ tên phiên, hoặc một cụm từ nằm trong hội thoại. Kết quả khớp tên luôn đứng trước."
        />
      )}

      {rows !== null && debounced && !results.length && scanning > 0 && (
        <Empty
          icon={SearchIcon}
          title="Chưa thấy phiên nào khớp ở tên"
          hint="Đang dò tiếp phần hội thoại của các phiên gần đây — chờ thêm chút nhé."
        />
      )}

      {rows !== null && debounced && !results.length && !scanning && (
        <Empty
          icon={SearchIcon}
          title={`Không tìm thấy “${debounced}”`}
          hint={
            scanned < rows.length
              ? `Mới quét nội dung ${scanned}/${rows.length} phiên — phiên cũ hơn chưa được dò. Thử thêm từ khoá hoặc bớt chữ.`
              : "Thử bớt từ khoá, hoặc kiểm tra lại chính tả."
          }
        />
      )}

      {results.map((r) => {
        const item = byId.get(r.id);
        return (
          <div
            key={`${r.wsId}:${r.id}`}
            class="card tap"
            role="button"
            tabIndex={0}
            onClick={() => open(item ?? r)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open(item ?? r);
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
              // `cmd-desc` là class chặn 2 dòng sẵn có — đoạn trích dài không
              // đẩy danh sách ra khỏi màn hình.
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
