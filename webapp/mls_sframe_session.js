// mls_sframe_session.js
// Gestione MLS → chiavi SFrame → KID dinamici

import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

// Backend MLS (unico) raggiungibile da tutti i peer
const SERVER_URL = "http://10.39.157.150:3000/mls/join";

function base64ToBytes(b64) {
  if (typeof b64 !== "string") {
    throw new Error("base64ToBytes: input non è una stringa, got: " + String(b64));
  }
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

// -----------------------------------------------------------------------------
// JOIN MLS
// -----------------------------------------------------------------------------
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

  // Log grezzo della risposta
  Output.mls("JOIN success:", data);

  // master_secret (base64 → bytes)
  const masterBytes = base64ToBytes(data.master_secret);

  return {
    sender_index: data.sender_index, // leaf index MLS del peer locale
    epoch: data.epoch,
    group_id: data.group_id,
    roster: data.roster,            // solo per log/debug
    master_secret: masterBytes,     // Uint8Array
  };
}

// -----------------------------------------------------------------------------
// Derivazione chiavi TX/RX (HKDF lato client) – GENERICO
// -----------------------------------------------------------------------------

// Chiave di trasmissione per questo sender_index
export async function deriveTxKey(master, senderIndex) {
  const label = `tx/${senderIndex}`;
  const key = await hkdf(master, label, 32);
  Output.mls("Derived TX Key", { senderIndex });
  return key;
}

// Chiave di ricezione per un dato sender_index remoto
export async function deriveRxKey(master, remoteSenderIndex) {
  const label = `rx/${remoteSenderIndex}`;
  const key = await hkdf(master, label, 32);
  Output.mls("Derived RX Key", { remoteSenderIndex });
  return key;
}

// -----------------------------------------------------------------------------
// KID dinamico (stile SFrame: epoch nei bit alti, index nei bassi)
// -----------------------------------------------------------------------------
export function computeKid(epoch, senderIndex) {
  // epoch e index relativamente piccoli → vanno bene in Number JS
  return (epoch << 16) | (senderIndex & 0xffff);
}

// -----------------------------------------------------------------------------
// Identity ↔ sender_index (per il signaling, es. Janus identity: "nome#3")
// -----------------------------------------------------------------------------

// Aggiunge il sender_index all'identity per il signaling.
// Esempio: ("win", 1)  → "win#1"
//          ("alice", 5) → "alice#5"
export function attachIndexToIdentity(identity, senderIndex) {
  return `${identity}#${senderIndex}`;
}

// Parsea una identity ricevuta dal signaling.
// Esempio: "win#1"   → { identity: "win", senderIndex: 1 }
//          "alice#5" → { identity: "alice", senderIndex: 5 }
//          "bob"     → { identity: "bob", senderIndex: null }  (niente index)
export function parseIdentityWithIndex(rawId) {
  const s = String(rawId ?? "");
  const [name, idxStr] = s.split("#");
  const idx = parseInt(idxStr, 10);
  return {
    identity: name,
    senderIndex: Number.isFinite(idx) ? idx : null,
  };
}
