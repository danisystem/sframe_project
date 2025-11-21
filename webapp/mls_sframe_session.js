// mls_sframe_session.js
// ---------------------------------------------------------
// Simulazione di una "sessione MLS" lato client.
// Ogni volta che un peer entra, genera:
// - master_secret random (che poi diventa audio/video secret via HKDF)
// - base_kid random
// - KID audio/video derivati dal base_kid
// ---------------------------------------------------------

import { hkdf } from './hkdf.js';

// Lunghezze reali SFrame / MLS
const SECRET_LEN = 32;  // 256 bit AES-GCM key
const KID_LEN = 8;      // 64-bit KID seed

// ---------------------------------------------------------
// Esporta:
//   initLocalMlsSession(displayName)
//     → { masterSecret, audioSecret, videoSecret, baseKid, kidAudio, kidVideo }
// ---------------------------------------------------------

export async function initLocalMlsSession(displayName) {
  // 1) master secret random (come se arrivasse da MLS)
  const masterSecret = new Uint8Array(SECRET_LEN);
  crypto.getRandomValues(masterSecret);

  // 2) base_kid random 64-bit
  const baseKidArray = new Uint8Array(KID_LEN);
  crypto.getRandomValues(baseKidArray);
  const baseKid = bytesToU64(baseKidArray);

  // 3) Deriva due segreti indipendenti
  const audioSecret = await hkdf(masterSecret, `audio:${displayName}`);
  const videoSecret = await hkdf(masterSecret, `video:${displayName}`);

  // 4) Deriva i KID come nel nativo
  const kidAudio = baseKid;
  const kidVideo = baseKid + 1;

  return {
    masterSecret,
    audioSecret,
    videoSecret,
    baseKid,
    kidAudio,
    kidVideo,
  };
}

// Helper per convertire 8 byte → numero
function bytesToU64(arr) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) + BigInt(arr[i]);
  }
  // Ritorna come Number se rientra, altrimenti BigInt
  return Number(v);
}
