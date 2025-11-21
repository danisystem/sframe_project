// appJanus.js
import { hkdf } from '../hkdf.js';

const els = {
  wsUrl: document.getElementById('wsUrl'),
  btnConnect: document.getElementById('btnConnect'),
  btnHangup: document.getElementById('btnHangup'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  btnToggleCam: document.getElementById('btnToggleCam'),
  localVideo: document.getElementById('localVideo'),
  remoteVideo: document.getElementById('remoteVideo'),
  log: document.getElementById('log'),
};

function log(...a) {
  els.log.value += a.map(String).join(' ') + '\n';
  els.log.scrollTop = els.log.scrollHeight;
}

function setConnectedUI(connected) {
  els.btnConnect.disabled = connected;
  els.btnHangup.disabled = !connected;
  els.btnToggleMic.disabled = !connected;
  els.btnToggleCam.disabled = !connected;

  if (!connected) {
    els.btnToggleMic.textContent = 'Mic OFF';
    els.btnToggleCam.textContent = 'Cam OFF';
  }
}

// ---- SFrame / chiavi ----
const KID_AUDIO = 1;
const KID_VIDEO = 2;
const BASE_SECRET = new TextEncoder().encode('DEV-ONLY-BASE-SECRET');

// WasmPeer TX e RX
let txPeer = null;
let rxPeer = null;

async function ensureSFramePeers() {
  if (txPeer && rxPeer) {
    return true;
  }
  if (!window.SFRAME?.WasmPeer) {
    log('⚠️ SFRAME non pronto (window.SFRAME.WasmPeer mancante), TX/RX in chiaro.');
    return false;
  }

  try {
    const secret = await hkdf(BASE_SECRET, 'sender=self');

    // TX: KID_AUDIO=1, KID_VIDEO=2
    txPeer = new window.SFRAME.WasmPeer(
      KID_AUDIO,
      KID_VIDEO,
      null,
      secret
    );

    // RX: full-duplex, usiamo solo RX audio/video=1/2
    rxPeer = window.SFRAME.WasmPeer.new_full_duplex(
      99, 98,          // tx dummy
      KID_AUDIO,
      KID_VIDEO,
      null,
      secret
    );

    log('SFrame WasmPeer TX/RX inizializzati.');
    return true;
  } catch (e) {
    console.error('ensureSFramePeers err', e);
    log('⚠️ Errore inizializzazione WasmPeer, TX/RX in chiaro.');
    txPeer = null;
    rxPeer = null;
    return false;
  }
}

// Stato Janus
let ws = null;
let sessionId = null;
let handleId = null;
const pendingTx = new Map();

// Stato WebRTC
let pc = null;
let localStream = null;
let audioTransceiver = null;
let videoTransceiver = null;

function makeTxId() {
  return 'tx-' + Math.random().toString(36).slice(2, 10);
}

function sendJanus(msg, { expectReply = true } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket non aperto');
  }
  const tx = makeTxId();
  msg.transaction = tx;
  if (sessionId && !('session_id' in msg)) {
    msg.session_id = sessionId;
  }
  if (handleId && !('handle_id' in msg) &&
      (msg.janus === 'message' || msg.janus === 'trickle' || msg.janus === 'detach')) {
    msg.handle_id = handleId;
  }

  const p = expectReply
    ? new Promise((resolve, reject) => {
        pendingTx.set(tx, { resolve, reject });
        setTimeout(() => {
          if (pendingTx.has(tx)) {
            pendingTx.delete(tx);
            reject(new Error('Timeout Janus per tx=' + tx));
          }
        }, 10000);
      })
    : Promise.resolve(null);

  ws.send(JSON.stringify(msg));
  return p;
}

function onJanusMessage(evt) {
  let msg;
  try {
    msg = JSON.parse(evt.data);
  } catch (e) {
    console.warn('JSON err:', e);
    return;
  }

  const { janus, transaction } = msg;

  if (transaction && pendingTx.has(transaction)) {
    const { resolve, reject } = pendingTx.get(transaction);
    pendingTx.delete(transaction);
    if (janus === 'success' || janus === 'ack') {
      resolve(msg);
    } else {
      reject(new Error('Janus returned: ' + janus));
    }
  }

  if (janus === 'event') {
    const plugindata = msg.plugindata;
    if (plugindata && plugindata.plugin === 'janus.plugin.echotest') {
      if (msg.jsep) {
        handleJanusJsep(msg.jsep);
      }
    }
  }

  if (janus === 'trickle' && msg.candidate && pc) {
    const c = msg.candidate;
    if (c.completed) {
      pc.addIceCandidate(null).catch(e => console.warn('addIceCandidate(null) err', e));
    } else {
      pc.addIceCandidate(c).catch(e => console.warn('addIceCandidate err', e));
    }
  }
}

async function handleJanusJsep(jsep) {
  if (!pc) {
    console.warn('pc non pronto ma ricevo jsep');
    return;
  }
  log('Janus JSEP:', jsep.type);
  await pc.setRemoteDescription(new RTCSessionDescription(jsep));
}

// ---------- Encoded Transforms: TX ----------
function attachSenderTransform(sender, kind) {
  if (!sender) {
    log('attachSenderTransform: sender mancante per', kind);
    return;
  }
  if (typeof sender.createEncodedStreams !== 'function') {
    log('⚠️ sender.createEncodedStreams non disponibile per ' + kind);
    return;
  }

  let streams;
  try {
    streams = sender.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(TX) ha lanciato su ' + kind + ': ' + (e.message || e));
    console.warn('createEncodedStreams sender error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform TX attaccato su', kind);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!txPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);
        let outU8;

        if (kind === 'audio') {
          outU8 = txPeer.encrypt_audio(inU8);
        } else {
          outU8 = txPeer.encrypt_video(inU8);
        }

        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const info = window.SFRAME.inspect(outU8);
            log(`[TX/${kind}] ${info}`);
          } catch {}
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('encrypt err', e);
        controller.enqueue(chunk);
      }
    }
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo TX err', e);
  });
}

// ---------- Encoded Transforms: RX ----------
function attachReceiverTransform(receiver, kind) {
  if (!receiver || typeof receiver.createEncodedStreams !== 'function') {
    log('⚠️ receiver.createEncodedStreams non disponibile per ' + kind);
    return;
  }

  let streams;
  try {
    streams = receiver.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(RX) ha lanciato su ' + kind + ': ' + (e.message || e));
    console.warn('createEncodedStreams receiver error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform RX attaccato su', kind);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!rxPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);

        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const info = window.SFRAME.inspect(inU8);
            log(`[RX/${kind}] ${info}`);
          } catch {}
        }

        let outU8;
        if (kind === 'audio') {
          outU8 = rxPeer.decrypt_audio(inU8);
        } else {
          outU8 = rxPeer.decrypt_video(inU8);
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('decrypt err', e);
        controller.enqueue(chunk);
      }
    }
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo RX err', e);
  });
}

// Crea PC e transceiver, attacca subito i transform, poi gUM + offer
async function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [],
  });

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) {
      sendJanus({
        janus: 'trickle',
        candidate: { completed: true },
      }, { expectReply: false }).catch(() => {});
      return;
    }
    sendJanus({
      janus: 'trickle',
      candidate: ev.candidate,
    }, { expectReply: false }).catch(e => console.warn('trickle err', e));
  };

  pc.ontrack = (ev) => {
    log('ontrack remoto:', ev.track.kind);
    if (!els.remoteVideo.srcObject) {
      els.remoteVideo.srcObject = ev.streams[0];
    }
  };

  await ensureSFramePeers();

  // Transceiver sendrecv pre-creati
  audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

  // Attacchiamo SUBITO i transform TX/RX
  attachSenderTransform(audioTransceiver.sender, 'audio');
  attachSenderTransform(videoTransceiver.sender, 'video');
  attachReceiverTransform(audioTransceiver.receiver, 'audio');
  attachReceiverTransform(videoTransceiver.receiver, 'video');

  // Ora prendiamo i track reali
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  els.localVideo.srcObject = localStream;

  const audioTrack = localStream.getAudioTracks()[0] || null;
  const videoTrack = localStream.getVideoTracks()[0] || null;

  if (audioTrack) {
    await audioTransceiver.sender.replaceTrack(audioTrack);
  }
  if (videoTrack) {
    await videoTransceiver.sender.replaceTrack(videoTrack);
  }

  // All'inizio consideriamo mic/cam ON
  els.btnToggleMic.textContent = 'Mic OFF';
  els.btnToggleCam.textContent = 'Cam OFF';

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  log('Invio JSEP offer a Janus');
  await sendJanus({
    janus: 'message',
    body: { audio: true, video: true },
    jsep: offer,
  });
}

async function connectAndStart() {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      log('WS già aperto');
      return;
    }

    const url = els.wsUrl.value.trim();
    log('Connessione a Janus WS:', url);
    ws = new WebSocket(url, 'janus-protocol');

    ws.onopen = async () => {
      log('WS aperto');
      try {
        const rspCreate = await sendJanus({ janus: 'create' });
        sessionId = rspCreate.data.id;
        log('Session ID:', sessionId);

        const rspAttach = await sendJanus({
          janus: 'attach',
          plugin: 'janus.plugin.echotest',
        });
        handleId = rspAttach.data.id;
        log('Handle ID (echotest):', handleId);

        await createPeerConnection();

        setConnectedUI(true);

      } catch (e) {
        log('ERRORE durante setup:', e.message || e);
      }
    };

    ws.onmessage = onJanusMessage;

    ws.onclose = (ev) => {
      log(`WS chiuso (code=${ev.code}, reason=${ev.reason || 'n/a'})`);
      cleanup();
    };

    ws.onerror = (e) => {
      console.error('WS error', e);
      log('WS error (vedi console per dettagli)');
    };

  } catch (e) {
    log('ERRORE connectAndStart:', e.message || e);
  }
}

function cleanup() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    try { pc.close(); } catch {}
  }
  pc = null;
  audioTransceiver = null;
  videoTransceiver = null;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = null;
  els.localVideo.srcObject = null;
  els.remoteVideo.srcObject = null;

  sessionId = null;
  handleId = null;
  pendingTx.clear();

  setConnectedUI(false);
}

async function hangup() {
  try {
    if (handleId) {
      await sendJanus({ janus: 'detach' });
    }
  } catch {}
  if (sessionId) {
    try {
      await sendJanus({ janus: 'destroy' });
    } catch {}
  }
  if (ws) {
    ws.close();
  }
  cleanup();
}

// ---------- MIC / CAM ----------
async function toggleMic() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) {
    log('Nessun audio track locale');
    return;
  }
  track.enabled = !track.enabled;
  els.btnToggleMic.textContent = track.enabled ? 'Mic OFF' : 'Mic ON';
  log('Mic ' + (track.enabled ? 'ON' : 'OFF'));
}

async function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) {
    log('Nessun video track locale');
    return;
  }
  track.enabled = !track.enabled;
  els.btnToggleCam.textContent = track.enabled ? 'Cam OFF' : 'Cam ON';
  log('Cam ' + (track.enabled ? 'ON' : 'OFF'));
}

// Bind bottoni
els.btnConnect.addEventListener('click', connectAndStart);
els.btnHangup.addEventListener('click', hangup);
els.btnToggleMic.addEventListener('click', toggleMic);
els.btnToggleCam.addEventListener('click', toggleCam);

setConnectedUI(false);
log('Janus EchoTest + SFrame app pronta. 1) Lancia docker Janus. 2) Avvia python -m http.server. 3) Apri http://localhost:5174/appJanus.html e premi Connect.');
