// ui.js
// Gestione elementi DOM, log e stato UI

export const els = {
  wsUrl: document.getElementById('wsUrl'),
  roomId: document.getElementById('roomId'),
  displayName: document.getElementById('displayName'),

  btnConnect: document.getElementById('btnConnect'),
  btnHangup: document.getElementById('btnHangup'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  btnToggleCam: document.getElementById('btnToggleCam'),

  localVideo: document.getElementById('localVideo'),
  remoteVideos: document.getElementById('remoteVideos'),

  log: document.getElementById('log'),
  chkSFrame: document.getElementById('chkSFrame'),
};

export function log(...a) {
  if (!els.log) return;
  els.log.value += a.map(String).join(' ') + '\n';
  els.log.scrollTop = els.log.scrollHeight;
}

export function setConnectedUI(connected) {
  if (!els.btnConnect || !els.btnHangup || !els.btnToggleMic || !els.btnToggleCam) return;

  els.btnConnect.disabled = connected;
  els.btnHangup.disabled = !connected;
  els.btnToggleMic.disabled = !connected;
  els.btnToggleCam.disabled = !connected;

  if (!connected) {
    els.btnToggleMic.textContent = 'Mic OFF';
    els.btnToggleCam.textContent = 'Cam OFF';
  }
}

// Log SFrame opzionale (solo se checkbox attivata)
export function logSFrame(...a) {
  if (!els.chkSFrame || !els.chkSFrame.checked) return;
  log(...a);
}
