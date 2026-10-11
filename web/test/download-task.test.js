import { test } from "node:test";
import assert from "node:assert/strict";
import { createDownloadTask } from "../src/lib/download-task.js";

// URL.createObjectURL/revokeObjectURL: Node 24 có sẵn cho Blob — nhưng để ĐẾM
// được lượt revoke (đúng điều module này sinh ra để ghim), thay bằng stub.
let urlCounter = 0;
const revoked = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
URL.createObjectURL = () => `blob:test-${++urlCounter}`;
URL.revokeObjectURL = (u) => revoked.push(u);

test.after?.(() => {});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTask({ downloadImpl } = {}) {
  const calls = { download: 0, onChange: [], onError: [], onSaved: [] };
  const lastArgs = { signal: undefined, onProgress: undefined };
  const task = createDownloadTask({
    download: async (args = {}) => {
      calls.download += 1;
      lastArgs.signal = args.signal;
      lastArgs.onProgress = args.onProgress;
      return (downloadImpl ?? (async () => ({ blob: new Blob(["x"]), filename: "f.bin" })))(
        args,
        calls
      );
    },
    onChange: (s) => calls.onChange.push(s),
    onError: (e) => calls.onError.push(e),
    onSaved: (r) => calls.onSaved.push(r),
  });
  return { task, calls, lastArgs };
}

test("start: state đi qua {loaded,total} -> {done,...} và onSaved nhận filename+url", async () => {
  const { task, calls } = makeTask({
    downloadImpl: async ({ onProgress }) => {
      onProgress?.({ loaded: 10, total: 100 });
      onProgress?.({ loaded: 50, total: 100 });
      return { blob: new Blob(["data"]), filename: "big.bin" };
    },
  });
  assert.equal(task.busy(), false);
  task.start();
  assert.equal(task.busy(), true, "đang chạy thì busy");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.onChange[0], { loaded: 0, total: 0 });
  assert.deepEqual(calls.onChange[1], { loaded: 10, total: 100 });
  assert.deepEqual(calls.onChange[2], { loaded: 50, total: 100 });
  const done = calls.onChange[3];
  assert.equal(done.done, true);
  assert.equal(done.filename, "big.bin");
  assert.match(done.url, /^blob:test-/);
  assert.deepEqual(calls.onSaved, [{ filename: "big.bin", url: done.url }]);
  assert.equal(task.busy(), false, "xong thì rảnh");
});

test("start khi đang chạy: no-op (không phát lượt tải thứ hai)", async () => {
  const gate = deferred();
  const { task, calls } = makeTask({ downloadImpl: () => gate.promise });
  task.start();
  task.start();
  task.start();
  assert.equal(calls.download, 1);
  gate.resolve({ blob: new Blob(["x"]), filename: "f.bin" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.onSaved.length, 1);
});

test("cancel giữa đường: state về null, promise cũ resolve KHÔNG phát done nữa", async () => {
  const gate = deferred();
  const { task, calls } = makeTask({ downloadImpl: () => gate.promise });
  task.start();
  task.cancel();
  assert.deepEqual(calls.onChange.at(-1), null);
  assert.equal(task.busy(), false);
  // Promise cũ còn unwind: mọi callback của nó phải vô hiệu.
  gate.resolve({ blob: new Blob(["late"]), filename: "late.bin" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.onSaved.length, 0, "lượt đã huỷ không được mở link tải");
  assert.deepEqual(calls.onChange.at(-1), null, "không phát state done của lượt chết");
});

test("restart sau khi done: revoke URL của lượt TRƯỚC, rồi mới mở lượt mới", async () => {
  const { task, calls } = makeTask();
  task.start();
  await new Promise((r) => setTimeout(r, 0));
  const firstUrl = calls.onChange.at(-1).url;
  revoked.length = 0;
  task.start();
  assert.deepEqual(revoked, [firstUrl], "URL done cũ phải revoke NGAY khi mở lượt mới");
  await new Promise((r) => setTimeout(r, 0));
  const secondUrl = calls.onChange.at(-1).url;
  assert.notEqual(secondUrl, firstUrl);
});

test("lỗi không phải AbortError -> onError + state null; AbortError im lặng", async () => {
  const { task, calls } = makeTask({
    downloadImpl: async () => {
      throw new Error("tunnel chết");
    },
  });
  task.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.onError.length, 1);
  assert.equal(calls.onError[0].message, "tunnel chết");
  assert.deepEqual(calls.onChange.at(-1), null);

  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  const { task: t2, calls: c2 } = makeTask({ downloadImpl: async () => { throw abortErr; } });
  t2.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c2.onError.length, 0, "hủy chủ đích không phải lỗi — khỏi báo đỏ");
  assert.deepEqual(c2.onChange.at(-1), null);
});

test("progress callback của lượt đã huỷ không được phát thành state mới", async () => {
  const { task, calls, lastArgs } = makeTask({ downloadImpl: () => new Promise(() => {}) });
  task.start();
  task.cancel();
  calls.onChange.length = 0;
  lastArgs.onProgress?.({ loaded: 99, total: 100 }); // callback của lượt CHẾT bắn muộn
  assert.deepEqual(calls.onChange, [], "stale progress phải bị token chặn");
  task.start();
  lastArgs.onProgress?.({ loaded: 1, total: 100 }); // callback của lượt MỚI thì đi
  assert.deepEqual(calls.onChange.at(-1), { loaded: 1, total: 100 });
});

test("getForShare: dùng lại lượt done (không tải lại), fresh thì tải mới và trả ownedUrl", async () => {
  const { task, calls } = makeTask();
  // Chưa có gì: tải mới KHÔNG signal (không nút huỷ nào nắm được luồng này).
  const fresh = await task.getForShare();
  assert.equal(calls.download, 1);
  assert.equal(fresh.url, undefined);
  assert.match(fresh.ownedUrl, /^blob:test-/);
  // Dispose phải thu hồi ownedUrl.
  revoked.length = 0;
  task.dispose();
  assert.deepEqual(revoked, [fresh.ownedUrl]);

  const { task: t2, calls: c2 } = makeTask();
  t2.start();
  await new Promise((r) => setTimeout(r, 0));
  const doneState = c2.onChange.at(-1);
  const reused = await t2.getForShare();
  assert.equal(c2.download, 1, "đã done thì KHÔNG tải lại");
  assert.equal(reused.url, doneState.url, "URL done được dùng lại, không tạo URL mới");
  assert.equal(reused.ownedUrl, undefined);
});

test("dispose: revoke URL done + URL share; huỷ lượt đang chạy", async () => {
  // Task có lượt done: dispose phải revoke URL done (bản cũ bỏ nhịp là iOS
  // Safari giết tab sau vài file lớn).
  const gate = deferred();
  const { task: running, calls: runningCalls } = makeTask({ downloadImpl: () => gate.promise });
  running.start();
  assert.equal(running.busy(), true);

  const { task: doneTask } = makeTask();
  doneTask.start();
  await new Promise((r) => setTimeout(r, 0));
  const doneUrl = doneTask.current().url;

  // Task share-only: getForShare khi CHƯA done -> ownedUrl riêng của lần share.
  const { task: shareTask } = makeTask();
  const share = await shareTask.getForShare();
  const shareUrl = share.ownedUrl;

  revoked.length = 0;
  doneTask.dispose();
  shareTask.dispose();
  running.dispose();
  assert.deepEqual(revoked.sort(), [doneUrl, shareUrl].sort());
  assert.equal(running.busy(), false, "dispose huỷ cả lượt đang chạy");
  gate.reject(Object.assign(new Error("x"), { name: "AbortError" }));
  await new Promise((r) => setTimeout(r, 0));
});
