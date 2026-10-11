import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHomeFeed } from "../src/lib/session-ops.js";
import { wsColor } from "../src/lib/format.js";

// Feed Home = gộp session mọi workspace + sort theo updated + cắt 30 (home.jsx
// giữ phần fetch; phần ghép thuần nằm ở lib/session-ops để node --test chạm tới).

test("mergeHomeFeed: gộp groups, sort theo updated mới nhất trên cùng", () => {
  const groups = [
    [{ ws: { id: "w1", name: "W1" }, session: { id: "s1", time: { updated: 10 } } }],
    [
      { ws: { id: "w2", name: "W2" }, session: { id: "s2", time: { updated: 30 } } },
      { ws: { id: "w2", name: "W2" }, session: { id: "s3", time: { updated: 20 } } },
    ],
  ];
  const { items } = mergeHomeFeed(groups, []);
  assert.deepEqual(items.map((it) => it.session.id), ["s2", "s3", "s1"]);
});

test("mergeHomeFeed: cắt đúng 30 dòng khi feed dài", () => {
  const groups = [
    Array.from({ length: 45 }, (_, i) => ({ ws: { id: "w" }, session: { id: `s${i}`, time: { updated: i } } })),
  ];
  const { items } = mergeHomeFeed(groups, []);
  assert.equal(items.length, 30);
  assert.equal(items[0].session.id, "s44");
});

test("mergeHomeFeed: status map key wsId:sid, entry rác bỏ qua, input lạ không ném", () => {
  const { items, statuses } = mergeHomeFeed(
    [[{ ws: { id: "w1" }, session: { id: "s1", time: { updated: 1 } } }]],
    [null, { wsId: "w1", map: { s1: { type: "busy" } } }]
  );
  assert.deepEqual(statuses, { "w1:s1": "busy" });
  assert.equal(mergeHomeFeed(null, undefined).items.length, 0);
  assert.deepEqual(mergeHomeFeed(null, undefined).statuses, {});
});

test("mergeHomeFeed: thiếu time.updated xếp cuối (không ném)", () => {
  const { items } = mergeHomeFeed(
    [
      [{ ws: { id: "w1" }, session: { id: "a" } }],
      [{ ws: { id: "w1" }, session: { id: "b", time: { updated: 5 } } }],
    ],
    []
  );
  assert.deepEqual(items.map((it) => it.session.id), ["b", "a"]);
});

// wsColor (lib/format.js) — trước đây search/workspaces import xuyên trang
// (from "./home.jsx"); bảng 8 màu phải giữ nguyên.
const PALETTE = ["#d6409f", "#30a46c", "#f76b15", "#0090ff", "#6e56cf", "#e2a336", "#12a594", "#e54666"];

test("wsColor trả màu trong bảng 8 màu desktop, cùng id -> cùng màu", () => {
  for (const id of ["", "main", "pc-abc", "workspace-2"]) {
    assert.ok(PALETTE.includes(wsColor(id)), id);
  }
  assert.equal(wsColor("main"), wsColor("main"), "ổn định giữa các lần render");
  // Bảng 8 màu nên hai id khác nhau CÓ THỂ đụng màu (hash mod 8) — ý định
  // phân biệt là thật nhưng không phải hợp đồng "luôn khác". Cặp này xác định
  // ra khác màu (#12a594 vs #0090ff).
  assert.notEqual(wsColor("zz-main"), wsColor("qq-other"));
});
