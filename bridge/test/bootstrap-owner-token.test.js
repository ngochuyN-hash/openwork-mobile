import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_TOKEN_ID, ensureOwnerToken, hashToken } from "../src/bootstrap.js";

// ensureOwnerToken reads OPENWORK_DIR (paths.js: openworkDataDir). Point it at
// a temp dir per test so we never touch the real %APPDATA%\openwork, then drop
// the dir. Same isolation trick as config.test.js with OPENWORK_BRIDGE_DIR.
const tempDirs = [];

function withOpenworkDir(tokensJson, fn) {
  const dir = mkdtempSync(join(tmpdir(), "owm-bootstrap-"));
  tempDirs.push(dir);
  const prev = process.env.OPENWORK_DIR;
  process.env.OPENWORK_DIR = dir;
  try {
    if (tokensJson !== null) {
      writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokensJson), "utf8");
    }
    return fn(join(dir, "tokens.json"));
  } finally {
    if (prev === undefined) delete process.env.OPENWORK_DIR;
    else process.env.OPENWORK_DIR = prev;
  }
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function readStore(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// (a) The 04/10 incident: config still holds the raw token but tokens.json lost
// its hash. The SAME token must come back - no minting, no rotation.
test("bootstrap: tokens.json thiếu hash thì chèn lại hash CŨ, không mint token mới", () => {
  const raw = "owt_preexisting_token_do_not_rotate";
  withOpenworkDir({ schemaVersion: 1, updatedAt: 1, tokens: [] }, (file) => {
    const before = hashToken(raw);
    const result = ensureOwnerToken(raw);

    assert.equal(result.token, raw, "token phải bền - không xoay");
    assert.equal(result.added, true);
    assert.equal(result.restartRequired, true, "OpenWork vẫn phải nạp lại");

    const after = readStore(file).tokens.find((t) => t.id === BRIDGE_TOKEN_ID);
    assert.ok(after, "entry của bridge phải có mặt");
    assert.equal(after.hash, before, "hash phải y hệt token cũ");
    assert.equal(after.scope, "owner");
  });
});

// Existing entries are kept: re-inserting must never delete anybody's token.
test("bootstrap: chèn lại không xoá entry khác đang có trong tokens.json", () => {
  const raw = "owt_another_preexisting_token";
  const other = { id: "some-other-app", hash: hashToken("whatever"), scope: "owner" };
  withOpenworkDir({ schemaVersion: 1, updatedAt: 1, tokens: [other] }, (file) => {
    const result = ensureOwnerToken(raw);
    assert.equal(result.token, raw);

    const tokens = readStore(file).tokens;
    assert.equal(tokens.length, 2);
    assert.deepEqual(tokens.filter((t) => t.id === "some-other-app"), [other]);
    assert.equal(tokens[0].id, BRIDGE_TOKEN_ID);
    assert.equal(tokens[0].hash, hashToken(raw));
  });
});

// (b) Steady state - nothing to write at all.
test("bootstrap: hash đã có sẵn thì không đụng tokens.json, added=false", () => {
  const raw = "owt_already_registered_token";
  withOpenworkDir(
    { schemaVersion: 1, updatedAt: 1, tokens: [{ id: BRIDGE_TOKEN_ID, hash: hashToken(raw), scope: "owner" }] },
    (file) => {
      const mtimeBefore = readFileSync(file, "utf8");
      const result = ensureOwnerToken(raw);

      assert.equal(result.token, raw);
      assert.equal(result.added, false);
      assert.equal(result.restartRequired, false);
      assert.equal(readFileSync(file, "utf8"), mtimeBefore, "file phải giữ nguyên");
    }
  );
});

// (c) Old behaviour, kept: no raw token in hand -> mint a fresh one and drop
// the orphan bridge entry whose hash we cannot reproduce.
test("bootstrap: không có raw token thì mint token mới (hành vi cũ)", () => {
  withOpenworkDir(
    { schemaVersion: 1, updatedAt: 1, tokens: [{ id: BRIDGE_TOKEN_ID, hash: "deadbeef", scope: "owner" }] },
    (file) => {
      const result = ensureOwnerToken("");

      assert.match(result.token, /^owt_[0-9a-f]{32}$/, "phải mint token mới");
      assert.equal(result.added, true);
      assert.equal(result.restartRequired, true);

      const tokens = readStore(file).tokens;
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].id, BRIDGE_TOKEN_ID);
      assert.equal(tokens[0].hash, hashToken(result.token));
      assert.notEqual(tokens[0].hash, "deadbeef", "entry orphan cũ phải bị thay");
    }
  );
});

// No tokens.json at all and no raw token - still mints, still writes the file.
test("bootstrap: thiếu cả tokens.json lẫn raw token thì tạo file mới", () => {
  withOpenworkDir(null, (file) => {
    assert.equal(existsSync(file), false);
    const result = ensureOwnerToken(undefined);
    assert.equal(result.added, true);
    assert.equal(readStore(file).tokens[0].hash, hashToken(result.token));
  });
});