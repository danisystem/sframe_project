// mls_sframe_session.js
// Gestione MLS → chiavi SFrame → KID dinamici

import { hkdf } from "./hkdf.js";
import { Output } from "./output.js";

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

  // ⚠️ Qui il campo corretto è *master_secret*, non sframe_master
  const masterBytes = base64ToBytes(data.master_secret);

  return {
    sender_index: data.sender_index,
    epoch: data.epoch,
    group_id: data.group_id,
    roster: data.roster,
    master_secret: masterBytes,
  };
}

// Deriva TX key
export async function deriveTxKey(master, senderIndex) {
  const label = `tx/${senderIndex}`;
  const key = await hkdf(master, label, 32);
  Output.mls("Derived TX Key", { senderIndex });
  return key;
}

// Deriva RX key peer-specifica
export async function deriveRxKey(master, remoteSenderIndex) {
  const label = `rx/${remoteSenderIndex}`;
  const key = await hkdf(master, label, 32);
  Output.mls("Derived RX Key", { remoteSenderIndex });
  return key;
}

// KID dinamico (stile SFrame: epoch nei bit alti, index nei bassi)
export function computeKid(epoch, senderIndex) {
  // epoch e index piccoli → va bene in Number JS
  return (epoch << 16) | senderIndex;
}