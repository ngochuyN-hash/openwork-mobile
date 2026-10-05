import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { openworkFilePath } from "./paths.js";

// Bootstrap our owner token into OpenWork's token store.
//
// OpenWork's TokenService (apps/server, dist/tokens.js) keeps tokens in
// %APPDATA%\openwork\tokens.json as sha256 hashes and loads the file ONCE at
// startup. So:
//  - we append {id, hash, scope:"owner"} for our token,
//  - OpenWork must be RESTARTED once to pick it up (restartRequired=true),
//  - after that the token works forever (create/revoke operations rewrite the
//    whole array from memory, which includes our entry).
//
// The RAW token is kept in the bridge config (outside the repo). Because the
// raw token survives bridge restarts, we can always RE-INSERT its hash when it
// goes missing from tokens.json instead of minting a new one - otherwise every
// restart would rotate the token and force yet another OpenWork restart
// (the 04/10 incident).

export const BRIDGE_TOKEN_ID = "openwork-mobile-bridge";
export const BRIDGE_TOKEN_LABEL = "OpenWork Mobile bridge";

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readTokenStore(file) {
  if (!existsSync(file)) return { schemaVersion: 1, updatedAt: Date.now(), tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed?.tokens)) return parsed;
  } catch {
    // fall through - treat as empty, we keep a .bak anyway
  }
  return { schemaVersion: 1, updatedAt: Date.now(), tokens: [] };
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/**
 * Make sure tokens.json contains a hash entry whose raw token we know.
 *
 * The raw token only ever lives in the bridge config, so as long as we hold it
 * the hash is reproducible: a missing entry is restored, never re-minted.
 *
 * @returns {{token: string, added: boolean, restartRequired: boolean}}
 *   added          - we wrote an entry to tokens.json this call
 *   restartRequired- OpenWork needs a restart before the token is honored
 */
export function ensureOwnerToken(existingRawToken) {
  const file = openworkFilePath("tokens.json");
  const store = readTokenStore(file);
  const raw = typeof existingRawToken === "string" ? existingRawToken.trim() : "";

  // Case 1: we hold a raw token and its hash is already in the store -> done.
  let token = "";
  let tokens = store.tokens;
  if (raw) {
    const hash = hashToken(raw);
    if (store.tokens.some((t) => t?.hash === hash)) {
      return { token: raw, added: false, restartRequired: false };
    }

    // Case 2: we hold the raw token but its hash is gone (tokens.json was
    // reset / rewritten without us). Re-INSERT THE SAME token's hash - minting
    // a new one here would rotate the token on every bridge restart and make
    // OpenWork demand yet another restart. No existing entry is removed.
    token = raw;
    tokens = [...store.tokens];
  } else {
    // Case 3: we lost the raw token (e.g. bridge config deleted). Any bridge
    // entry left behind is an orphan we cannot reproduce - drop it and mint a
    // fresh one.
    token = `owt_${randomUUID().replace(/-/g, "")}`;
    tokens = store.tokens.filter((t) => t?.id !== BRIDGE_TOKEN_ID);
  }

  tokens.unshift({
    id: BRIDGE_TOKEN_ID,
    hash: hashToken(token),
    scope: "owner",
    createdAt: Date.now(),
    label: BRIDGE_TOKEN_LABEL,
  });

  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  atomicWrite(file, { schemaVersion: 1, updatedAt: Date.now(), tokens });
  return { token, added: true, restartRequired: true };
}
