// ui.js
// ─────────────────────────────────────────────
// Raccolta elementi UI + funzioni helper
// ─────────────────────────────────────────────

export const els = {
  wsUrl: document.getElementById("wsUrl"),
  roomId: document.getElementById("roomId"),
  displayName: document.getElementById("displayName"),

  btnConnect: document.getElementById("btnConnect"),
  btnHangup: document.getElementById("btnHangup"),
  btnToggleMic: document.getElementById("btnToggleMic"),
  btnToggleCam: document.getElementById("btnToggleCam"),

  localVideo: document.getElementById("localVideo"),
  remoteVideos: document.getElementById("remoteVideos"),

  log: document.getElementById("log"),
  chkSFrame: document.getElementById("chkSFrame"),
};

// ─────────────────────────────────────────────
// UI State Manager
// ─────────────────────────────────────────────

export function setConnectedUI(connected) {
  els.btnConnect.disabled = connected;
  els.btnHangup.disabled = !connected;
  els.btnToggleMic.disabled = !connected;
  els.btnToggleCam.disabled = !connected;

  if (!connected) {
    els.btnToggleMic.textContent = "Mic OFF";
    els.btnToggleCam.textContent = "Cam OFF";
    els.log.value = "";
  }
}
