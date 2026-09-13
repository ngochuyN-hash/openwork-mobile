import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rateLimitDelayMs,
  plainRetryDelayMs,
  saveTunnelState,
  loadTunnelState,
  tunnelStateFile,
} from "../src/tunnel.js";

test("tunnel: thang backoff 429 là 2ph nhân đôi trần 10ph; retry thường 5s trần 60s", () => {
  assert.equal(rateLimitDelayMs(1), 120_000);
  assert.equal(rateLimitDelayMs(2), 240_000);
  assert.equal(rateLimitDelayMs(3), 480_000);
  assert.equal(rateLimitDelayMs(4), 600_000);
  assert.equal(rateLimitDelayMs(9), 600_000, "trần 10 phút");
  assert.equal(plainRetryDelayMs(1), 5_000);
  assert.equal(plainRetryDelayMs(2), 10_000);
  assert.equal(plainRetryDelayMs(9), 60_000, "trần 60s");
});

test("tunnel: state backoff SỐNG QUA restart — save/load qua tunnel-state.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "owm-tunnel-"));
  process.env.OPENWORK_BRIDGE_DIR = dir; // bridgeDataDir đọc env lúc GỌI, không lúc import
  try {
    saveTunnelState({ phase: "backoff", url: "", streak: 3, nextAttemptAt: 123456 });
    const st = loadTunnelState();
    assert.equal(st.phase, "backoff");
    assert.equal(st.streak, 3);
    assert.equal(st.nextAttemptAt, 123456);
    assert.ok(typeof st.updatedAt === "number", "ghi kèm updatedAt");
    assert.ok(tunnelStateFile().startsWith(dir));

    saveTunnelState({ phase: "up", url: "https://abc123.trycloudflare.com", streak: 0, nextAttemptAt: 0 });
    const up = loadTunnelState();
    assert.equal(up.phase, "up");
    assert.equal(up.url, "https://abc123.trycloudflare.com");

    writeFileSync(tunnelStateFile(), "{rác không phải JSON", "utf8");
    assert.equal(loadTunnelState(), null, "file hỏng -> coi như không có state, không làm bridge chết");
  } finally {
    delete process.env.OPENWORK_BRIDGE_DIR;
  }
});
