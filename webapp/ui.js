// ui.js
// --------------------------------------------------------------------
// Gestione elementi UI e stati (mic/cam/log/SFrame log)
// --------------------------------------------------------------------

// Raccolta centralizzata dei riferimenti agli elementi DOM.
// Se un elemento non esiste in pagina, il valore sarà null.
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

// Flag booleano controllato dal pulsante "SFrame Log"
let sframeLogEnabled = false;

/**
 * Abilita/disabilita il log dettagliato SFrame.
 * Aggiorna lo stato interno e la UI del pulsante.
 */
export function toggleSFrameLog() {
  sframeLogEnabled = !sframeLogEnabled;

  if (els.btnSframeLog) {
    els.btnSframeLog.classList.toggle("on", sframeLogEnabled);
    els.btnSframeLog.classList.toggle("off", !sframeLogEnabled);
    els.btnSframeLog.textContent = sframeLogEnabled
      ? "SFrame Log: ON"
      : "SFrame Log: OFF";
  }
}

/**
 * Ritorna true se il log SFrame è abilitato.
 * Usato da output.js per decidere se stampare gli header SFrame.
 */
export function isSFrameLogEnabled() {
  return sframeLogEnabled;
}

// Bind evento sul pulsante, se presente in DOM
if (els.btnSframeLog) {
  els.btnSframeLog.addEventListener("click", toggleSFrameLog);
}

// --------------------------------------------------------------------
// UI generale: abilitazione/disabilitazione controlli in base a "connected"
// --------------------------------------------------------------------

/**
 * Aggiorna lo stato della UI in base alla connessione:
 * - connected = true: disabilita "Connect", abilita "Hangup" e mic/cam
 * - connected = false: resetta testo bottoni mic/cam e disabilita controlli.
 * (I log non vengono più cancellati per permettere il debug post-disconnessione).
 */
export function setConnectedUI(connected) {
  if (els.btnConnect) els.btnConnect.disabled = connected;
  if (els.btnHangup) els.btnHangup.disabled = !connected;
  if (els.btnToggleMic) els.btnToggleMic.disabled = !connected;
  if (els.btnToggleCam) els.btnToggleCam.disabled = !connected;

  if (!connected) {
    if (els.btnToggleMic) els.btnToggleMic.textContent = "Mic OFF";
    if (els.btnToggleCam) els.btnToggleCam.textContent = "Cam OFF";
    // FIX: Rimossa la pulizia automatica di els.log.value = "" 
    // per non perdere lo storico di eventuali errori!
  }
}