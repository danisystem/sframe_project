// output.js
// Logging per categorie
// Con supporto per header SFrame (solo se abilitato da UI)

import { isSFrameLogEnabled } from "./ui.js";

const logEl = document.getElementById("log");

function write(category, ...msg) {
  const line = `[${category}] ${
    msg
      .map(m => (typeof m === "object" ? JSON.stringify(m) : String(m)))
      .join(" ")
  }`;

  console.log(line);

  if (logEl) {
    logEl.value += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
}

export const Output = {
  mls:   (...msg) => write("MLS", ...msg),
  sframe:(...msg) => write("SFRAME", ...msg),
  janus: (...msg) => write("JANUS", ...msg),
  webrtc:(...msg) => write("WEBRTC", ...msg),
  ui:    (...msg) => write("UI", ...msg),
  error: (...msg) => write("ERROR", ...msg),

  // ------------------------------------------------------------
  // 🔥 Log dedicato agli HEADER SFrame
  //
  // direction: "TX" | "RX"
  // kind:      "audio" | "video"
  //
  // info (dal WASM):
  //   {
  //     kid: number,
  //     ctr: number,
  //     header_len: number,
  //     aad_len: number,
  //     ct_len: number,
  //     tag_len: number,
  //     total_len: number,
  //
  //     // opzionali (se in futuro li esponiamo da WASM):
  //     header_hex?: string,
  //     nonce_hex?: string,
  //     aad_hex?: string,
  //     tag_hex?: string
  //   }
  // ------------------------------------------------------------
  sframeHeader(direction, kind, info) {
    if (!isSFrameLogEnabled()) return;

    if (!info) {
      write("SFRAME", `[HDR] ${direction} ${kind} | <no info>`);
      return;
    }

    const baseLine =
      `${direction} ${kind} | ` +
      `kid=${info.kid} ` +
      `ctr=${info.ctr} ` +
      `aad=${info.aad_len}B ` +
      `ct=${info.ct_len}B ` +
      `tag=${info.tag_len}B ` +
      `total=${info.total_len}B`;

    // Riga base compatibile col vecchio formato
    write("SFRAME", baseLine);

    // Se abbiamo dettagli extra, li stampiamo in righe successive
    const extras = [];

    if (info.header_hex) {
      extras.push(`header=${info.header_hex}`);
    }
    if (info.nonce_hex) {
      extras.push(`nonce=${info.nonce_hex}`);
    }
    if (info.aad_hex) {
      extras.push(`aad_hex=${info.aad_hex}`);
    }
    if (info.tag_hex) {
      extras.push(`tag=${info.tag_hex}`);
    }

    if (extras.length > 0) {
      write(
        "SFRAME",
        `[HDR-DETAIL] ${direction} ${kind} | ` + extras.join(" | ")
      );
    }
  }
};
