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
// The RAW token is kept in the bridge config (outside the repo).

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
 * @returns {{token: string, added: boolean, restartRequired: boolean}}
 *   added          - we appended a new entry to tokens.json this call
 *   restartRequired- OpenWork needs a restart before the token is honored
 */
export function ensureOwnerToken(existingRawToken) {
  const file = openworkFilePath("tokens.json");
  const store = readTokenStore(file);

  // Case 1: we already hold a raw token whose hash is present -> done.
  if (existingRawToken) {
    const hash = hashToken(existingRawToken);
    if (store.tokens.some((t) => t?.hash === hash)) {
      return { token: existingRawToken, added: false, restartRequired: false };
    }
  }

  // Case 2: an old bridge entry exists but we lost the raw token (e.g. bridge
  // config deleted). Drop the orphan entry and mint a fresh one - a hash we
  // cannot reproduce is useless to us.
  const tokens = store.tokens.filter((t) => t?.id !== BRIDGE_TOKEN_ID);

  const token = `owt_${randomUUID().replace(/-/g, "")}`;
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
