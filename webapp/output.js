// output.js
// -------------------------------------------------------------
// Sistema di logging centralizzato per la webapp.
//
// - Log su console (formato: [CATEGORIA] messaggio/json)
// - Log opzionale in una <textarea id="log">, se presente in pagina
// - Supporto per log dedicati agli header SFrame (sframeHeader),
//   abilitati/disabilitati da UI tramite isSFrameLogEnabled().
// -------------------------------------------------------------

import { isSFrameLogEnabled } from "./ui.js";

let logTextarea = null;

/**
 * Restituisce (con caching) l'elemento <textarea id="log">, se esiste.
 * Evita query ripetute e problemi di accesso al DOM troppo presto.
 */
function getLogElement() {
  if (logTextarea === null) {
    logTextarea = document.getElementById("log") || undefined;
  }
  return logTextarea;
}

/**
 * Scrive una riga di log con categoria e messaggio.
 *
 * - category: stringa (es. "MLS", "SFRAME", "JANUS", "UI", "ERROR")
 * - msg: lista di argomenti (stringhe, numeri, oggetti)
 *
 * Gli oggetti vengono serializzati in JSON per log compatti.
 */
function write(category, ...msg) {
  const text = msg
    .map((m) => {
      if (m instanceof Error) {
        return `${m.name}: ${m.message}`;
      }
      if (typeof m === "object") {
        try {
          return JSON.stringify(m);
        } catch {
          return String(m);
        }
      }
      return String(m);
    })
    .join(" ");

  const line = `[${category}] ${text}`;

  // Console: console.error per "ERROR", console.log per gli altri
  if (category === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }

  // Log in textarea, se presente
  const el = getLogElement();
  if (el) {
    el.value += line + "\n";
    el.scrollTop = el.scrollHeight;
  }
}

export const Output = {
  mls: (...msg) => write("MLS", ...msg),
  sframe: (...msg) => write("SFRAME", ...msg),
  janus: (...msg) => write("JANUS", ...msg),
  webrtc: (...msg) => write("WEBRTC", ...msg),
  ui: (...msg) => write("UI", ...msg),
  error: (...msg) => write("ERROR", ...msg),

  // ------------------------------------------------------------
  // 🔥 Log dedicato agli HEADER SFrame
  //
  // direction: "TX" | "RX"
  // kind: "audio" | "video"
  //
  // info (dal WASM):
  // {
  //   kid: number,
  //   ctr: number,
  //   header_len: number,
  //   aad_len: number,
  //   ct_len: number,
  //   tag_len: number,
  //   total_len: number,
  //   header_hex?: string,
  //   nonce_hex?: string,
  //   aad_hex?: string,
  //   tag_hex?: string
  // }
  // ------------------------------------------------------------
  sframeHeader(direction, kind, info) {
    if (!isSFrameLogEnabled()) return;

    if (!info) {
      write("SFRAME", `[HDR] ${direction} ${kind} | <no info>`);
      return;
    }

    // Riga principale compatibile col vecchio formato
    const baseLine = `${direction} ${kind} | + kid=${info.kid} + ctr=${info.ctr} + aad=${info.aad_len}B + ct=${info.ct_len}B + tag=${info.tag_len}B + total=${info.total_len}B`;
    write("SFRAME", baseLine);

    // Dettagli extra opzionali
    const extras = [];
    if (info.header_hex) extras.push(`header=${info.header_hex}`);
    if (info.nonce_hex) extras.push(`nonce=${info.nonce_hex}`);
    if (info.aad_hex) extras.push(`aad_hex=${info.aad_hex}`);
    if (info.tag_hex) extras.push(`tag=${info.tag_hex}`);

    if (extras.length > 0) {
      write("SFRAME", `[HDR-DETAIL] ${direction} ${kind} | + ${extras.join(" | ")}`);
    }
  },
};