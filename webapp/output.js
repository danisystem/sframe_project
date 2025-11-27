// output.js
// Logging per categorie
// Con supporto per header SFrame (solo se abilitato da UI)

import { isSFrameLogEnabled } from "./ui.js";

const logEl = document.getElementById("log");

function write(category, ...msg) {
  const line = `[${category}] ${
    msg.map(m => typeof m === "object" ? JSON.stringify(m) : String(m)).join(" ")
  }`;

  console.log(line);

  if (logEl) {
    logEl.value += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
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
  // 🔥 Log dedicato agli HEADER SFrame (senza ciphertext)
  // ------------------------------------------------------------
  sframeHeader(direction, kind, info) {
    if (!isSFrameLogEnabled()) return;

    const kidLen =
      info.kid_len_bytes === 0 ? "inline" : `${info.kid_len_bytes}B`;
    const ctrLen =
      info.ctr_len_bytes === 0 ? "inline" : `${info.ctr_len_bytes}B`;

    const line =
      `${direction} ${kind} | ` +
      `kid=${info.kid} (len=${kidLen}) ` +
      `ctr=${info.ctr} (len=${ctrLen}) ` +
      `aad=${info.aad_len}B ` +
      `ct=${info.ct_len}B ` +
      `tag=${info.tag_len}B ` +
      `total=${info.total_len}B`;

    write("SFRAME", line);
  }
};
