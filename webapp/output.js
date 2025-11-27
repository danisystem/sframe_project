// output.js
// Logging modulare e categorizzato per MLS / SFrame / Janus / WebRTC / Error

import { els } from "./ui.js";
const logEl = document.getElementById("log");

function write(category, ...msg) {
  const line = `[${category}] ${msg.map(m => 
    typeof m === "object" ? JSON.stringify(m) : String(m)
  ).join(" ")}`;

  

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
};
