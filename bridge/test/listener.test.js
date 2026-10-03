import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("listener stops after ten EADDRINUSE retries", () => {
  // Evaluate only listener wiring, never the bridge's config/bootstrap side effects.
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf('let attempt = 0;');
  const end = source.indexOf('process.on("SIGINT"', start);
  let onError;
  let scheduled = 0;
  let listens = 0;
  const exits = [];
  const stopped = new Error("process exited");
  runInNewContext(source.slice(start, end), {
    server: {
      on: (_event, handler) => { onError = handler; },
      listen: () => { listens += 1; },
    },
    config: { port: 12345 },
    onListening: () => {},
    console: { warn() {}, error() {} },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 400);
      scheduled += 1;
      callback();
    },
    process: { exit: (code) => { exits.push(code); throw stopped; } },
  });
  for (let i = 0; i < 10; i += 1) onError({ code: "EADDRINUSE" });
  assert.equal(scheduled, 10);
  assert.equal(listens, 11);
  assert.throws(() => onError({ code: "EADDRINUSE" }), (error) => error === stopped);
  assert.deepEqual(exits, [1]);
  assert.equal(scheduled, 10);
});
