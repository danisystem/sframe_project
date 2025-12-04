// mls_sframe_session.js
// MLS → distribuzione segreti per SFrame (webapp, multi-room)

import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

// Usiamo path relativi: ci pensa secure.server.js a fare da proxy verso 127.0.0.1:3000
const SERVER_JOIN_PATH   = "/mls/join";
const SERVER_ROSTER_PATH = "/mls/roster";

function base64ToBytes(b64) {
  if (typeof b64 !== "string") {
    throw new Error("base64ToBytes: input non è una stringa");
  }
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

// ---------------- MLS JOIN ----------------
//
// Ogni join ora è per (room_id, identity):
//   - room_id   = Room Janus (es. 123456)
//   - identity  = "dani", "mac", ecc.

export async function mlsJoin(identity, roomId) {
  Output.mls("JOIN →", { identity, roomId });

  const resp = await fetch(SERVER_JOIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // ⚠️ campo che il server Rust si aspetta: room_id
    body: JSON.stringify({ identity, room_id: roomId }),
  });

  if (!resp.ok) {
    throw new Error("Join MLS failed: HTTP " + resp.status);
  }

  const data = await resp.json();
  Output.mls("JOIN success:", data);

  const masterBytes = base64ToBytes(data.master_secret);

  return {
    sender_index: data.sender_index,
    epoch: data.epoch,
    group_id: data.group_id,
    room_id: data.room_id,
    roster: data.roster,
    master_secret: masterBytes,
  };
}

// ---------------- MLS ROSTER (refresh) ----------------
//
// GET /mls/roster?room_id=123456

export async function mlsFetchRoster(roomId) {
  const url = `${SERVER_ROSTER_PATH}?room_id=${encodeURIComponent(roomId)}`;

  const resp = await fetch(url, {
    method: "GET",
  });

  if (!resp.ok) {
    throw new Error("Roster MLS failed: HTTP " + resp.status);
  }

  const data = await resp.json();
  Output.mls("ROSTER update:", data);
  return data; // { epoch, group_id, room_id, roster }
}

// ---------------- Derivazione chiavi ----------------

function labelForSender(senderIndex) {
  return `sframe/sender/${senderIndex}`;
}

// Chiave TX per questo peer (sender_index locale)
export async function deriveTxKey(master, senderIndex) {
  const key = await hkdf(master, labelForSender(senderIndex), 32);
  Output.mls("Derived TX Key", { senderIndex });
  return key;
}

// Chiave RX per un certo sender_index remoto
export async function deriveRxKey(master, remoteSenderIndex) {
  const key = await hkdf(master, labelForSender(remoteSenderIndex), 32);
  Output.mls("Derived RX Key", { remoteSenderIndex });
  return key;
}

// ---------------- KID univoci (epoch + room + sender) ----------------

export function computeKid(epoch, roomId, senderIndex) {
  const e = Number(epoch) >>> 0;
  const r = Number(roomId) >>> 0;
  const s = Number(senderIndex) >>> 0;

  // layout: [ epoch | roomId | senderIndex | mediaBit ]
  // epoch * 1e9  + room * 1e4 + sender * 10
  const base = e * 1_000_000_000 + r * 10_000 + s * 10;
  return base; // audio; video = base + 1
}

// ---------------- Identity helper ----------------

export function attachIndexToIdentity(name, senderIndex) {
  return `${name}#${senderIndex}`;
}

export function parseIdentityWithIndex(display) {
  const idx = display.lastIndexOf("#");
  if (idx < 0) {
    return { identity: display, senderIndex: null };
  }
  const identity = display.slice(0, idx);
  const indexStr = display.slice(idx + 1);
  const i = Number(indexStr);
  if (!Number.isFinite(i)) {
    return { identity: display, senderIndex: null };
  }
  return { identity, senderIndex: i };
}
