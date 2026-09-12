import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListeningPorts, isOpenWorkServerHealth } from "../src/discovery.js";
import { isProxyPathAllowed, isMethodAllowed, normalizeDotSegments } from "../src/proxy.js";
import { isAuthorized } from "../src/auth.js";
import { hashToken } from "../src/bootstrap.js";
import { createHash } from "node:crypto";

test("parseListeningPorts filters by pid and extracts ports", () => {
  const netstat = [
    "  TCP    127.0.0.1:62222    0.0.0.0:0    LISTENING    14316",
    "  TCP    127.0.0.1:49362    0.0.0.0:0    LISTENING    14316",
    "  TCP    127.0.0.1:49363    0.0.0.0:0    LISTENING    17020",
    "  TCP    0.0.0.0:443        0.0.0.0:0    LISTENING    4",
  ].join("\r\n");
  assert.deepEqual(parseListeningPorts(netstat, 14316).sort(), [49362, 62222]);
  assert.deepEqual(parseListeningPorts(netstat, 9999), []);
});

test("isOpenWorkServerHealth requires ok + opencodeVersion", () => {
  assert.equal(isOpenWorkServerHealth({ ok: true, opencodeVersion: "1.18.18" }), true);
  assert.equal(isOpenWorkServerHealth({ ok: true, app: "OpenWork", version: 2 }), false);
  assert.equal(isOpenWorkServerHealth(null), false);
});

test("proxy whitelist allows management paths, blocks everything else", () => {
  const allow = [
    "/workspaces",
    "/workspaces/local",
    "/workspace/ws_1/session-groups",
    "/workspace/ws_1/opencode/session",
    "/workspace/ws_1/opencode/session/ses_1/message",
    "/workspace/ws_1/files/content",
    "/approvals",
    "/approvals/appr_1",
    "/files/sessions/ses_1/ops",
    "/experimental/ui-control/pending",
    "/status",
  ];
  for (const p of allow) assert.equal(isProxyPathAllowed(p), true, p);

  const deny = [
    "/tokens",
    "/env",
    "/dev/log",
    "/workspace/ws_1/secret",
    "/workspace/ws_1/opencode/../../hack",
    "/runtime/upgrade",
  ];
  for (const p of deny) assert.equal(isProxyPathAllowed(normalizeDotSegments(p)), false, p);
});

test("normalizeDotSegments resolves traversal before whitelist", () => {
  assert.equal(normalizeDotSegments("/workspace/ws_1/opencode/../../hack"), "/workspace/hack");
  assert.equal(normalizeDotSegments("/a/./b/../c/"), "/a/c");
});

test("method allowlist", () => {
  assert.equal(isMethodAllowed("GET"), true);
  assert.equal(isMethodAllowed("POST"), true);
  assert.equal(isMethodAllowed("PUT"), true);
  assert.equal(isMethodAllowed("DELETE"), true);
  assert.equal(isMethodAllowed("TRACE"), false);
});

test("bridge auth requires exact bearer token", () => {
  const token = "owm_abc";
  const req = (value) => ({ headers: { authorization: value } });
  assert.equal(isAuthorized(req(`Bearer ${token}`), token), true);
  assert.equal(isAuthorized(req(`Bearer ${token}x`), token), false);
  assert.equal(isAuthorized(req(undefined), token), false);
  assert.equal(isAuthorized(req("Basic abc"), token), false);
});

test("hashToken matches OpenWork's sha256 scheme", () => {
  const token = "owt_deadbeef";
  assert.equal(hashToken(token), createHash("sha256").update(token).digest("hex"));
});
