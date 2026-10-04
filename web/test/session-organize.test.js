// Test logic thuần của việc SẮP XẾP PHIÊN (lib/session-organize.js).
// Cờ ghim/lưu trữ chạy trên localStorage giả nên test không cần DOM; phần
// nhóm phiên test đúng hợp đồng server (state/assignments, reorder, delete).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAGS_KEY,
  MAX_GROUP_LABEL_LENGTH,
  UNGROUPED_ID,
  UNGROUPED_LABEL,
  emptyFlags,
  normalizeFlags,
  loadFlags,
  saveFlags,
  flagOn,
  toggleFlag,
  updatedAt,
  sortByUpdated,
  splitByFlags,
  selectSessions,
  emptyGroupState,
  normalizeGroupState,
  groupStateFromResponse,
  groupIdOf,
  setAssignment,
  normalizeGroupLabel,
  renameGroup,
  makeGroupId,
  addGroup,
  removeGroup,
  reorderGroups,
  moveGroup,
  groupCounts,
  sessionGroupsPath,
  sessionGroupPath,
  sessionGroupReorderPath,
  sessionGroupAssignmentPath,
  removeGroupPath,
  buildReorderBody,
  buildAssignBody,
} from "../src/lib/session-organize.js";

/** localStorage giả — chỉ cần getItem/setItem như trình duyệt. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    raw: map,
  };
}

const ses = (id, updated = 0, extra = {}) => ({ id, title: `phiên ${id}`, time: { updated, ...extra } });

// ==================== CỜ GHIM / LƯU TRỮ (localStorage) ====================

test("loadFlags đọc cờ theo từng workspace, workspace khác không lẫn", () => {
  const store = fakeStorage({
    [FLAGS_KEY]: JSON.stringify({
      ws_a: { pinned: ["ses_1"], archived: [] },
      ws_b: { pinned: [], archived: ["ses_2", "ses_2"] },
    }),
  });
  assert.deepEqual(loadFlags("ws_a", store), { pinned: ["ses_1"], archived: [] });
  assert.deepEqual(loadFlags("ws_b", store), { pinned: [], archived: ["ses_2"] }); // bỏ trùng
  assert.deepEqual(loadFlags("ws_chua_co", store), emptyFlags()); // chưa có -> rỗng, KHÔNG ném
});

test("loadFlags sống sót localStorage hỏng (JSON rác) thay vì làm chết màn hình", () => {
  const store = fakeStorage({ [FLAGS_KEY]: "{không phải json" });
  assert.deepEqual(loadFlags("ws_a", store), emptyFlags());
});

test("saveFlags ghi đúng workspace và KHÔNG đụng workspace khác", () => {
  const store = fakeStorage();
  saveFlags("ws_a", toggleFlag(emptyFlags(), "pinned", "ses_1"), store);
  saveFlags("ws_b", toggleFlag(emptyFlags(), "archived", "ses_9"), store);
  assert.deepEqual(loadFlags("ws_a", store).pinned, ["ses_1"]);
  assert.deepEqual(loadFlags("ws_a", store).archived, []);
  assert.deepEqual(loadFlags("ws_b", store).archived, ["ses_9"]);
  // ghi đè lần hai không nuốt nhóm đã ghim
  saveFlags("ws_a", toggleFlag(loadFlags("ws_a", store), "archived", "ses_5"), store);
  assert.deepEqual(loadFlags("ws_a", store), { pinned: ["ses_1"], archived: ["ses_5"] });
});

test("toggleFlag bật/tắt và trả object MỚI (không sửa tại chỗ)", () => {
  const base = emptyFlags();
  const on = toggleFlag(base, "pinned", "ses_1");
  assert.equal(flagOn(on, "pinned", "ses_1"), true);
  assert.deepEqual(base, emptyFlags(), "object cũ không được dính");
  assert.deepEqual(toggleFlag(on, "pinned", "ses_1"), emptyFlags());
  // id rỗng là rác không ai xoá được -> bỏ qua; kind lạ -> không đụng gì
  assert.deepEqual(toggleFlag(base, "pinned", ""), emptyFlags());
  assert.deepEqual(toggleFlag(base, "khong_co_kind", "ses_1"), emptyFlags());
});

test("normalizeFlags chịu được dữ liệu bậy (số, null, mảng lồng)", () => {
  assert.deepEqual(normalizeFlags({ pinned: [1, " ses_2 ", "ses_2", null], archived: "x" }), {
    pinned: ["ses_2"],
    archived: [],
  });
  assert.deepEqual(normalizeFlags(null), emptyFlags());
  assert.deepEqual(normalizeFlags([1, 2]), emptyFlags());
});

// ==================== BỌC / SẮP XẾP DANH SÁCH ====================

test("splitByFlags tách ghim / còn lại / lưu trữ", () => {
  const list = [ses("a"), ses("b"), ses("c"), ses("d")];
  const flags = { pinned: ["a"], archived: ["c"] };
  const out = splitByFlags(list, flags);
  assert.deepEqual(out.pinned.map((s) => s.id), ["a"]);
  assert.deepEqual(out.rest.map((s) => s.id), ["b", "d"]);
  assert.deepEqual(out.archived.map((s) => s.id), ["c"]);
});

test("selectSessions: mặc định ẩn phiên đã lưu trữ, sắp mới nhất lên đầu", () => {
  const list = [ses("a", 100), ses("b", 300), ses("c", 200)];
  const flags = { pinned: [], archived: ["c"] };
  assert.deepEqual(selectSessions(list, { flags }).map((s) => s.id), ["b", "a"]);
  assert.deepEqual(selectSessions(list, { flags, scope: "archived" }).map((s) => s.id), ["c"]);
});

test("selectSessions mặc định VẪN thấy phiên đã ghim, và ghim đứng trên cùng", () => {
  // BUG ĐÃ SỬA: "Tất cả" lấy mỗi buckets.rest nên phiên ghim biến mất khỏi
  // danh sách chính ngay sau khi bấm ghim (mục "Ghim" thì thấy, "Tất cả" thì không).
  const list = [ses("a", 100), ses("b", 300), ses("c", 200)];
  const flags = { pinned: ["a"], archived: ["c"] };
  assert.deepEqual(selectSessions(list, { flags }).map((s) => s.id), ["a", "b"], "ghim lên đầu, lưu trữ thì ẩn");
  assert.deepEqual(selectSessions(list, { flags, scope: "pinned" }).map((s) => s.id), ["a"]);
});

test("selectSessions lọc theo nhóm, có ô riêng cho phiên chưa nhóm", () => {
  const state = { groups: [{ id: "g1", label: "Work A" }], assignments: { a: "g1", b: "" } };
  const list = [ses("a", 100), ses("b", 200)];
  const flags = emptyFlags();
  const opts = { flags, groupState: state };
  assert.deepEqual(selectSessions(list, { ...opts, groupId: "g1" }).map((s) => s.id), ["a"]);
  assert.deepEqual(selectSessions(list, { ...opts, groupId: UNGROUPED_ID }).map((s) => s.id), ["b"]);
  assert.deepEqual(selectSessions(list, opts).map((s) => s.id), ["b", "a"], "không lọc nhóm -> cả hai, mới nhất trước");
});

test("sortByUpdated không sửa mảng gốc, chịu thiếu time", () => {
  const list = [ses("a"), ses("b", 50)];
  const sorted = sortByUpdated(list);
  assert.deepEqual(sorted.map((s) => s.id), ["b", "a"]);
  assert.deepEqual(list.map((s) => s.id), ["a", "b"], "mảng gốc phải nguyên");
  assert.equal(updatedAt(null), 0);
});

// ==================== NHÓM PHIÊN — chuẩn hoá state ====================

test("normalizeGroupState nhận được cả response {state}, state thô, và rác", () => {
  const raw = { groups: [{ id: "g1", label: "Work A" }], assignments: { a: "g1" } };
  assert.deepEqual(normalizeGroupState({ state: raw, updatedAt: 1 }), raw);
  assert.deepEqual(normalizeGroupState(raw), raw);
  assert.deepEqual(groupStateFromResponse({ state: raw, updatedAt: 5 }), raw);
  assert.deepEqual(normalizeGroupState(null), emptyGroupState());
  assert.deepEqual(normalizeGroupState([1, 2]), emptyGroupState());
});

test("normalizeGroupState dọn nhóm thiếu id, id trùng và assignment trỏ nhóm ma", () => {
  const out = normalizeGroupState({
    groups: [{ id: "", label: "rác" }, { id: "g1", label: "A" }, { id: "g1", label: "trùng" }, { id: " " }],
    assignments: { a: "g1", b: "khong_ton_tai", c: "", "": "g1" },
  });
  assert.deepEqual(out.groups, [{ id: "g1", label: "A" }]);
  assert.deepEqual(out.assignments, { a: "g1" });
});

test("groupIdOf: nhóm đã xoá trả rỗng chứ không giữ assignment rác", () => {
  const state = { groups: [{ id: "g1", label: "Work A" }], assignments: { a: "g1", b: "g_x" } };
  assert.equal(groupIdOf(state, "a"), "g1");
  assert.equal(groupIdOf(state, "b"), ""); // g_x không còn trong groups
});

// ==================== NHÓM — gán / bỏ gán ====================

test("setAssignment gán, bỏ gán, và coi nhóm không tồn tại như bỏ gán (khớp server)", () => {
  const state = { groups: [{ id: "g1", label: "A" }], assignments: {} };
  const g1 = setAssignment(state, "a", "g1");
  assert.equal(groupIdOf(g1, "a"), "g1");
  assert.deepEqual(groupIdOf(setAssignment(g1, "a", ""), "a"), ""); // bỏ khỏi nhóm
  // session-groups.ts:117-136: groupId không có trong state thì XOÁ assignment
  assert.equal(groupIdOf(setAssignment(g1, "a", "g_ma"), "a"), "");
  assert.deepEqual(setAssignment(state, "", "g1"), state); // sessionId rỗng -> no-op
});

test("setAssignment không sửa state cũ", () => {
  const state = { groups: [{ id: "g1", label: "A" }], assignments: {} };
  setAssignment(state, "a", "g1");
  assert.deepEqual(state.assignments, {});
});

// ==================== NHÓM — tên / tạo / đổi tên ====================

test("normalizeGroupLabel dẹp khoảng trắng, chặn rỗng và chặn quá trần", () => {
  assert.deepEqual(normalizeGroupLabel("  Work\n  A  "), { ok: true, label: "Work A" });
  assert.equal(normalizeGroupLabel("   ").error, "Group name cannot be empty.");
  assert.equal(normalizeGroupLabel("Work".repeat(200)).error, `Group name can be at most ${MAX_GROUP_LABEL_LENGTH} characters.`);
  // không cắt âm thầm: quá trần thì báo lỗi, người dùng giữ nguyên ô nhập
  assert.equal(normalizeGroupLabel("a".repeat(MAX_GROUP_LABEL_LENGTH + 1)).ok, false);
  const atLimit = normalizeGroupLabel("a".repeat(MAX_GROUP_LABEL_LENGTH));
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.label.length, MAX_GROUP_LABEL_LENGTH);
});

test("normalizeGroupLabel cắt theo code point, không cắt đôi emoji", () => {
  const label = "😀".repeat(120); // 240 đơn vị UTF-16 nhưng 120 ký tự
  const ok = normalizeGroupLabel(label);
  assert.equal(ok.ok, true);
  assert.equal([...ok.label].length, 120);
  assert.ok(!ok.label.includes("\ufffd"), "không được để lại ký tự hỏng");
});

test("makeGroupId slug không dấu tiếng Việt, trùng thì thêm hậu tố", () => {
  assert.equal(makeGroupId("Work A"), "work-a");
  assert.equal(makeGroupId("  Đ  "), "d");
  assert.equal(makeGroupId("!!!"), "group"); // không còn ký tự nào dùng được
  assert.equal(makeGroupId("Work A", ["work-a"]), "work-a-2");
  assert.equal(makeGroupId("Work A", ["work-a", "work-a-2"]), "work-a-3");
  assert.equal(makeGroupId("Work A").length <= 128, true);
});

test("addGroup thêm nhóm mới với id tự sinh, tên trùng vẫn tạo được (id có hậu tố)", () => {
  const out = addGroup(emptyGroupState(), "Work A");
  assert.equal(out.ok, true);
  assert.equal(out.id, "work-a");
  assert.deepEqual(out.state.groups, [{ id: "work-a", label: "Work A" }]);
  // hai nhóm cùng tên: id tự sinh phải khác, không được sinh id trùng
  const again = addGroup(out.state, "Work A");
  assert.equal(again.ok, true);
  assert.equal(again.id, "work-a-2");
  assert.deepEqual(again.state.groups.map((g) => g.id), ["work-a", "work-a-2"]);
  // chỉ khi id trùng mới báo lỗi — không tạo nhóm ma
  const clash = addGroup(out.state, "Other", { id: "work-a" });
  assert.equal(clash.ok, false);
  assert.equal(addGroup(emptyGroupState(), "  ").ok, false);
});

// ==================== NHÓM — đổi tên / xoá / sắp lại ====================

test("renameGroup đổi nhãn, nhóm không tồn tại hoặc tên sai thì KHÔNG sửa gì", () => {
  const state = { groups: [{ id: "g1", label: "Cũ" }], assignments: { a: "g1" } };
  const out = renameGroup(state, "g1", " Mới\n đẹp ");
  assert.equal(out.ok, true);
  assert.deepEqual(out.state.groups, [{ id: "g1", label: "Mới đẹp" }]);
  assert.deepEqual(out.state.assignments, { a: "g1" }, "đổi tên không đụng assignment");

  const bad = renameGroup(state, "g1", "  ");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.state, state, "state phải y nguyên");
  assert.equal(renameGroup(state, "g_x", "Mới").ok, false);
});

test("removeGroup chuyển phiên sang nhóm đích, không xoá phiên", () => {
  const state = {
    groups: [{ id: "g1", label: "A" }, { id: "g2", label: "B" }],
    assignments: { s1: "g1", s2: "g1", s3: "g2" },
  };
  const moved = removeGroup(state, "g1", "g2");
  assert.deepEqual(moved.groups, [{ id: "g2", label: "B" }]);
  assert.deepEqual(moved.assignments, { s1: "g2", s2: "g2", s3: "g2" });
  // không có nhóm đích -> thành "chưa nhóm" (bỏ hẳn khỏi assignments)
  const loose = removeGroup(state, "g1");
  assert.deepEqual(loose.assignments, { s3: "g2" });
  assert.deepEqual(state.groups.length, 2, "state cũ không sửa tại chỗ");
});

test("removeGroup bỏ qua nhóm đích không tồn tại hoặc trùng chính nhóm đang xoá", () => {
  const state = { groups: [{ id: "g1", label: "A" }], assignments: { s1: "g1" } };
  assert.deepEqual(removeGroup(state, "g1", "g1").assignments, {}, "trùng chính nó -> không đích");
  assert.deepEqual(removeGroup(state, "g1", "g_ma").assignments, {});
});

test("reorderGroups giữ nhóm không nhắc ở CUỐI và bỏ id lạ", () => {
  const state = {
    groups: [{ id: "g1", label: "A" }, { id: "g2", label: "B" }, { id: "g3", label: "C" }],
    assignments: { s: "g2" },
  };
  const out = reorderGroups(state, ["g3", "g_ma", "g1"]);
  assert.deepEqual(out.groups.map((g) => g.id), ["g3", "g1", "g2"]);
  assert.deepEqual(out.assignments, { s: "g2" });
  assert.deepEqual(reorderGroups(state, []).groups.map((g) => g.id), ["g1", "g2", "g3"], "rỗng -> giữ nguyên");
  // id lặp trong danh sách không sinh nhóm trùng
  assert.deepEqual(reorderGroups(state, ["g2", "g2"]).groups.map((g) => g.id), ["g2", "g1", "g3"]);
});

test("moveGroup đổi chỗ nhóm liền kề, chặn hai đầu", () => {
  const state = { groups: [{ id: "g1" }, { id: "g2" }, { id: "g3" }], assignments: {} };
  assert.deepEqual(moveGroup(state, "g3", -1).groups.map((g) => g.id), ["g1", "g3", "g2"]);
  assert.deepEqual(moveGroup(state, "g1", 1).groups.map((g) => g.id), ["g2", "g1", "g3"]);
  assert.deepEqual(moveGroup(state, "g1", -1).groups.map((g) => g.id), ["g1", "g2", "g3"], "đã ở đầu");
  assert.deepEqual(moveGroup(state, "g3", 1).groups.map((g) => g.id), ["g1", "g2", "g3"], "đã ở cuối");
  assert.deepEqual(moveGroup(state, "khong_co", 1).groups.map((g) => g.id), ["g1", "g2", "g3"]);
});

test("groupCounts đếm phiên mỗi nhóm, nhóm rỗng vẫn có mục 0", () => {
  const state = { groups: [{ id: "g1" }, { id: "g2" }], assignments: { a: "g1" } };
  assert.deepEqual(groupCounts([ses("a"), ses("b")], state), { g1: 1, g2: 0 });
});

// ==================== PATH + BODY (đã whitelist ở bridge) ====================

test("path nhóm phiên đúng /workspace/{id}/session-groups và encode id", () => {
  assert.equal(sessionGroupsPath("ws a"), "/workspace/ws%20a/session-groups");
  assert.equal(sessionGroupPath("ws1", "g 1"), "/workspace/ws1/session-groups/g%201");
  assert.equal(sessionGroupReorderPath("ws1"), "/workspace/ws1/session-groups/reorder");
  assert.equal(sessionGroupAssignmentPath("ws1", "ses 1"), "/workspace/ws1/session-groups/assignments/ses%201");
});

test("removeGroupPath chỉ kèm destinationGroupId khi thật sự có nhóm đích", () => {
  assert.equal(removeGroupPath("ws1", "g1"), "/workspace/ws1/session-groups/g1");
  assert.equal(removeGroupPath("ws1", "g1", ""), "/workspace/ws1/session-groups/g1");
  assert.equal(removeGroupPath("ws1", "g1", "g1"), "/workspace/ws1/session-groups/g1", "không tự trỏ về chính nó");
  assert.equal(removeGroupPath("ws1", "g1", "g 2"), "/workspace/ws1/session-groups/g1?destinationGroupId=g%202");
});

test("buildReorderBody luôn là mảng string sạch, buildAssignBody rỗng = gỡ nhóm", () => {
  assert.deepEqual(buildReorderBody(["g2", " g1 ", "", null]), { groupIds: ["g2", "g1"] });
  assert.deepEqual(buildReorderBody(null), { groupIds: [] });
  assert.deepEqual(buildAssignBody("g1"), { groupId: "g1" });
  assert.deepEqual(buildAssignBody("  "), { groupId: "" });
});
