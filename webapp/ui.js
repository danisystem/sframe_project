// ui.js
// --------------------------------------------------------------------
// Gestione elementi UI e stati (mic/cam/log)
// --------------------------------------------------------------------

export const els = {
  wsUrl: document.getElementById("wsUrl"),
  roomId: document.getElementById("roomId"),
  displayName: document.getElementById("displayName"),

  btnConnect: document.getElementById("btnConnect"),
  btnHangup: document.getElementById("btnHangup"),
  btnToggleMic: document.getElementById("btnToggleMic"),
  btnToggleCam: document.getElementById("btnToggleCam"),

  btnSframeLog: document.getElementById("btnSframeLog"),

  localVideo: document.getElementById("localVideo"),
  remoteVideos: document.getElementById("remoteVideos"),

  log: document.getElementById("log"),
};

// --------------------------------------------------------------------
// Stato interno per SFrame Log
// --------------------------------------------------------------------
let sframeLogEnabled = false;

export function toggleSFrameLog() {
  sframeLogEnabled = !sframeLogEnabled;

  els.btnSframeLog.classList.toggle("on", sframeLogEnabled);
  els.btnSframeLog.classList.toggle("off", !sframeLogEnabled);
  els.btnSframeLog.textContent = sframeLogEnabled
    ? "SFrame Log: ON"
    : "SFrame Log: OFF";
}

export function isSFrameLogEnabled() {
  return sframeLogEnabled;
}

// Bind evento
els.btnSframeLog.addEventListener("click", toggleSFrameLog);

// --------------------------------------------------------------------
// UI generale
// --------------------------------------------------------------------
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
