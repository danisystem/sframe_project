// mls_sframe_session.js
// MLS → distribuzione segreti per SFrame (webapp)

import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

// Backend MLS rust (warp) – adatta l'IP se serve
const SERVER_URL = "http://10.39.157.150:3000/mls/join";

function base64ToBytes(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

// ---------------- MLS JOIN ----------------

export async function mlsJoin(identity) {
  Output.mls("JOIN →", identity);

  const resp = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity }),
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
    roster: data.roster,
    master_secret: masterBytes,
  };
}

// ---------------- Derivazione chiavi ----------------
//
// IMPORTANTE: per ogni sender_index usiamo *la stessa label*
// per TX e RX, così tutti i peer derivano la STESSA chiave
// per (sender_index).

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

// ---------------- KID univoci ----------------
//
// computeKid(epoch, senderIndex):
//   - epoch nei bit "alti" (blocchi grandi)
//   - senderIndex in un blocco più piccolo
//
// Audio = kidAudio
// Video = kidAudio + 1
//
// (basta per una demo, restiamo ampiamente sotto 2^53)

export function computeKid(epoch, senderIndex) {
  const base = Number(epoch) * 1_000_000 + Number(senderIndex) * 10;
  return base; // audio
  // video = base + 1 (lo fa appRoom)
}

// ---------------- Identity helper ----------------
//
// "nome#index" per poter recuperare il sender_index
// direttamente dal display Janus.

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
