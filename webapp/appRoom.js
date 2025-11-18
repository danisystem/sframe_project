// appRoom.js
// ─────────────────────────────────────────────────────────────
// Janus VideoRoom + SFrame (Insertable Streams) + multi-peer
// ─────────────────────────────────────────────────────────────
//
// Layer logici:
//
//   1. UI           : gestione bottoni, log, <video> DOM
//   2. SFrame       : derivazione chiavi, WasmPeer, encrypt/decrypt
//   3. WebRTC       : RTCPeerConnection (publisher/subscriber)
//   4. Janus SFU    : signaling via WebSocket (VideoRoom plugin)
//
// Il flusso:
//
//   - Ogni client entra nella room Janus come PUBLISHER (audio+video).
//   - Janus annuncia gli altri publisher (feedId, display).
//   - Per ogni feed remoto creiamo un SUBSCRIBER (RTCPeerConnection).
//   - SFrame cripta i nostri frame (TX) e decripta quelli remoti (RX).
//
// Le chiavi:
//
//   - C’è un BASE_SECRET comune (dev).
//   - Per ogni sender usiamo HKDF(BASE_SECRET, "sender=<displayName>").
//   - Questo secret alimenta WasmPeer (libreria sframe-rs via WebAssembly).
//
// ─────────────────────────────────────────────────────────────

import { hkdf } from './hkdf.js';

// ─────────────────────────────────────────────────────────────
// 1. UI
// ─────────────────────────────────────────────────────────────

const els = {
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

// Log SFrame opzionale (solo se checkbox attivata)
function logSFrame(...a) {
  if (!els.chkSFrame || !els.chkSFrame.checked) return;
  log(...a);
}

// ─────────────────────────────────────────────────────────────
// 2. SFrame / Crypto layer (HKDF + WasmPeer)
// ─────────────────────────────────────────────────────────────

// KID fissati: 1=audio, 2=video
const KID_AUDIO = 1;
const KID_VIDEO = 2;

// Secret base di sviluppo (in futuro: exporter da MLS)
const BASE_SECRET = new TextEncoder().encode('DEV-ONLY-BASE-SECRET');

// TX peer locale (usato per cifrare i frame che inviamo)
let txPeer = null;

// Mappa feedId → subscriber info
// sub = {
//   feedId,
//   display,
//   handleId,
//   pc,
//   videoEl,
//   rxPeer,   // WasmPeer per decifrare SFrame di quel feed
// }
const subscribers = new Map();

/**
 * Deriva un secret per-mittente a partire dall’etichetta logica
 * (nel nostro caso: displayName = identity nella room).
 *
 * In futuro, al posto di BASE_SECRET, si userà un exporter da MLS.
 */
async function deriveSenderSecret(senderLabel) {
  return hkdf(BASE_SECRET, `sender=${senderLabel}`);
}

/**
 * Inizializza il WasmPeer per TX locale, se non esiste.
 * Ritorna true se TX SFrame è pronto, false se invieremo in chiaro.
 */
async function ensureTxPeerForLocal() {
  if (txPeer) return true;
  if (!window.SFRAME?.WasmPeer) {
    log('⚠️ SFRAME non pronto (WasmPeer mancante), TX in chiaro.');
    return false;
  }

  let disp = (els.displayName.value || '').trim();
  if (!disp) {
    disp = 'user-' + Math.random().toString(36).slice(2, 8);
    els.displayName.value = disp;
  }

  try {
    const secret = await deriveSenderSecret(disp);
    txPeer = new window.SFRAME.WasmPeer(
      KID_AUDIO,
      KID_VIDEO,
      null,
      secret,
    );
    log('Local SFrame TX peer pronto per', disp);
    return true;
  } catch (e) {
    console.error('ensureTxPeerForLocal err', e);
    log('⚠️ Errore inizializzazione TX peer, TX in chiaro.');
    txPeer = null;
    return false;
  }
}

/**
 * Inizializza, se necessario, il WasmPeer RX per un certo feed remoto.
 */
async function ensureRxPeerForFeed(sub) {
  if (sub.rxPeer) return true;
  if (!window.SFRAME?.WasmPeer) {
    log(`⚠️ SFRAME non pronto (RX), feed=${sub.feedId}, RX in chiaro.`);
    return false;
  }

  const label = sub.display || String(sub.feedId);
  try {
    const secret = await deriveSenderSecret(label);
    sub.rxPeer = window.SFRAME.WasmPeer.new_full_duplex(
      99, 98,             // TX dummy
      KID_AUDIO,
      KID_VIDEO,
      null,
      secret,
    );
    log(`SFrame RX peer pronto per feed=${sub.feedId} (${label})`);
    return true;
  } catch (e) {
    console.error('ensureRxPeerForFeed err', e);
    log(`⚠️ Errore inizializzazione RX peer per feed=${sub.feedId}, RX in chiaro.`);
    sub.rxPeer = null;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 3. WebRTC layer (RTCPeerConnection + Insertable Streams)
// ─────────────────────────────────────────────────────────────

// Stato Janus / WebRTC per il publisher (noi)
let ws = null;
let sessionId = null;
let pluginHandlePub = null;
let pcPub = null;
let localStream = null;

// Helpers vari
function makeTxId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===== TX: attach transform su RTCRtpSender =====

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

        // Log opzionale header SFrame TX
        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const info = window.SFRAME.inspect(outU8);
            logSFrame(`[TX/${kind}] ${info}`);
          } catch {}
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('encrypt err', e);
        controller.enqueue(chunk);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo TX err', e);
  });
}

// ===== RX: attach transform su RTCRtpReceiver =====

function attachReceiverTransform(receiver, kind, sub) {
  if (!receiver) {
    log('attachReceiverTransform: receiver mancante per', kind, 'feed=', sub.feedId);
    return;
  }
  if (typeof receiver.createEncodedStreams !== 'function') {
    log('⚠️ receiver.createEncodedStreams non disponibile per ' + kind + ' feed=' + sub.feedId);
    return;
  }

  let streams;
  try {
    streams = receiver.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(RX) ha lanciato su ' + kind + ' feed=' + sub.feedId + ': ' + (e.message || e));
    console.warn('createEncodedStreams receiver error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform RX attaccato su', kind, 'feed=', sub.feedId);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!sub.rxPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);

        // Log opzionale header SFrame RX
        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const hdrInfo = window.SFRAME.inspect(inU8);
            logSFrame(`[RX/${kind} feed=${sub.feedId}] ${hdrInfo}`);
          } catch {}
        }

        let outU8;
        if (kind === 'audio') {
          outU8 = sub.rxPeer.decrypt_audio(inU8);
        } else {
          outU8 = sub.rxPeer.decrypt_video(inU8);
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('decrypt err', e);
        controller.enqueue(chunk);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo RX err', e);
  });
}

// ─────────────────────────────────────────────────────────────
// 4. Janus SFU layer (VideoRoom plugin via WebSocket)
// ─────────────────────────────────────────────────────────────

function sendJanus(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('⚠️ WebSocket non aperto, impossibile inviare:', JSON.stringify(msg));
    return;
  }
  ws.send(JSON.stringify(msg));
}

function onJanusMessage(evt) {
  let msg;
  try {
    msg = JSON.parse(evt.data);
  } catch (e) {
    console.warn('JSON err', e);
    return;
  }

  const { janus } = msg;

  if (janus === 'success') {
    handleJanusSuccess(msg);
  } else if (janus === 'event') {
    handleJanusEvent(msg);
  } else if (janus === 'trickle') {
    handleJanusTrickle(msg);
  } else if (janus === 'webrtcup') {
    log('WebRTC UP per handle', msg.sender);
  } else if (janus === 'hangup') {
    log('Janus hangup per handle', msg.sender, 'reason=', msg.reason);
  } else if (janus === 'error') {
    log('❌ Janus ERROR:', msg.error?.reason || JSON.stringify(msg.error));
  }
}

// ===== success (create / attach) =====

function handleJanusSuccess(msg) {
  const { transaction, data } = msg;

  // Session create
  if (transaction && transaction.startsWith('create-')) {
    sessionId = data.id;
    log('Session ID:', sessionId);
    attachPublisherHandle();
    return;
  }

  // Attach publisher handle
  if (transaction && transaction.startsWith('attach-pub-')) {
    pluginHandlePub = data.id;
    log('Publisher handle ID:', pluginHandlePub);
    joinAsPublisher();
    return;
  }

  // Attach subscriber handle (uno per feed)
  if (transaction && transaction.startsWith('attach-sub-')) {
    const feedIdStr = transaction.split('attach-sub-')[1];
    const feedId = Number(feedIdStr);
    const sub = subscribers.get(feedId);
    if (sub) {
      sub.handleId = data.id;
      log(`Subscriber handle per feed ${feedId}:`, sub.handleId);
      joinAsSubscriber(feedId, sub.handleId);
    }
  }
}

// ===== event (VideoRoom plugin) =====

function handleJanusEvent(msg) {
  const sender = msg.sender;
  const plugindata = msg.plugindata;
  const jsep = msg.jsep;

  if (!plugindata || plugindata.plugin !== 'janus.plugin.videoroom') {
    return;
  }
  const data = plugindata.data || {};
  const vr = data.videoroom;

  // Eventi relativi al nostro handle publisher
  if (sender === pluginHandlePub) {
    if (vr === 'joined') {
      log('✅ Joined room come publisher. ID interno:', data.id);

      if (Array.isArray(data.publishers)) {
        log(
          'Publisher già presenti:',
          data.publishers.map(p => p.display || p.id).join(', ') || '(nessuno)',
        );
        data.publishers.forEach(p => {
          subscribeToPublisher(p.id, p.display);
        });
      }
      startPublishing();
    } else if (vr === 'event') {
      // Nuovi publisher nella room
      if (Array.isArray(data.publishers)) {
        data.publishers.forEach(p => {
          log('Nuovo publisher nella room:', p.display || p.id);
          subscribeToPublisher(p.id, p.display);
        });
      }
      // Publisher che abbandonano
      if (data.unpublished) {
        const feed = data.unpublished;
        log('Publisher rimosso:', feed);
        removeSubscriber(feed);
      }
    }

    if (jsep && pcPub) {
      log('Ricevuto JSEP answer per publisher');
      pcPub.setRemoteDescription(new RTCSessionDescription(jsep)).catch(e => {
        console.error('setRemoteDescription(pub) err', e);
        log('❌ setRemoteDescription(pub) err:', e.message || e);
      });
    }
    return;
  }

  // Eventi relativi agli handle subscriber (feed remoti)
  for (const [feedId, sub] of subscribers.entries()) {
    if (sub.handleId === sender) {
      if (vr === 'attached') {
        log(`Subscriber attached per feed ${feedId}`);
      }
      if (jsep) {
        handleSubscriberJsep(feedId, sub, jsep);
      }
      break;
    }
  }
}

// ===== trickle ICE (dal server) =====

function handleJanusTrickle(msg) {
  const c = msg.candidate;
  if (!c) return;
  // Per semplicità ignoriamo le trickle da Janus:
  // normalmente le trickle inviate da noi bastano per unirsi.
}

// ─────────────────────────────────────────────────────────────
// Publisher (noi) su VideoRoom
// ─────────────────────────────────────────────────────────────

function attachPublisherHandle() {
  const tx = makeTxId('attach-pub');
  sendJanus({
    janus: 'attach',
    plugin: 'janus.plugin.videoroom',
    transaction: tx,
    session_id: sessionId,
  });
}

function joinAsPublisher() {
  const room = Number(els.roomId.value) || 1234;
  let disp = (els.displayName.value || '').trim();
  if (!disp) {
    disp = 'user-' + Math.random().toString(36).slice(2, 8);
    els.displayName.value = disp;
  }
  log('Join come publisher nella room', room, 'con displayName=', disp);

  sendJanus({
    janus: 'message',
    transaction: makeTxId('join-pub'),
    session_id: sessionId,
    handle_id: pluginHandlePub,
    body: {
      request: 'join',
      ptype: 'publisher',
      room,
      display: disp,
    },
  });
}

async function startPublishing() {
  try {
    const room = Number(els.roomId.value) || 1234;
    log('Avvio publish nella room', room);

    pcPub = new RTCPeerConnection({ iceServers: [] });

    pcPub.onicecandidate = ev => {
      if (!ev.candidate) {
        sendJanus({
          janus: 'trickle',
          transaction: makeTxId('trickle-end-pub'),
          session_id: sessionId,
          handle_id: pluginHandlePub,
          candidate: { completed: true },
        });
        return;
      }
      sendJanus({
        janus: 'trickle',
        transaction: makeTxId('trickle-pub'),
        session_id: sessionId,
        handle_id: pluginHandlePub,
        candidate: ev.candidate,
      });
    };

    pcPub.oniceconnectionstatechange = () => {
      log('pcPub ICE state:', pcPub.iceConnectionState);
    };

    const sframeOk = await ensureTxPeerForLocal();
    if (!sframeOk) {
      log('⚠️ SFrame TX non attivo: invieremo in chiaro (solo SRTP).');
    }

    // Media locale
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = localStream;

    els.btnToggleMic.textContent = 'Mic OFF';
    els.btnToggleCam.textContent = 'Cam OFF';

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      const senderA = pcPub.addTrack(audioTrack, localStream);
      if (sframeOk) attachSenderTransform(senderA, 'audio');
    }

    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      const senderV = pcPub.addTrack(videoTrack, localStream);
      if (sframeOk) attachSenderTransform(senderV, 'video');
    }

    const offer = await pcPub.createOffer();
    await pcPub.setLocalDescription(offer);

    sendJanus({
      janus: 'message',
      transaction: makeTxId('publish'),
      session_id: sessionId,
      handle_id: pluginHandlePub,
      body: {
        request: 'publish',
        audio: true,
        video: true,
      },
      jsep: offer,
    });

    log('Offer inviato per publish');
  } catch (e) {
    console.error('startPublishing err', e);
    log('❌ startPublishing err:', e.message || e);
  }
}

// ─────────────────────────────────────────────────────────────
// Subscriber per ogni feed remoto
// ─────────────────────────────────────────────────────────────

function subscribeToPublisher(feedId, display) {
  if (subscribers.has(feedId)) return;

  const sub = {
    feedId,
    display: display || String(feedId),
    handleId: null,
    pc: null,
    videoEl: null,
    rxPeer: null,
  };
  subscribers.set(feedId, sub);

  const tx = `attach-sub-${feedId}`;
  sendJanus({
    janus: 'attach',
    plugin: 'janus.plugin.videoroom',
    transaction: tx,
    session_id: sessionId,
  });
}

function joinAsSubscriber(feedId, handleId) {
  const room = Number(els.roomId.value) || 1234;
  log(`Join come subscriber per feed=${feedId} room=${room}`);

  sendJanus({
    janus: 'message',
    transaction: makeTxId(`join-sub-${feedId}`),
    session_id: sessionId,
    handle_id: handleId,
    body: {
      request: 'join',
      ptype: 'subscriber',
      room,
      feed: feedId,
    },
  });
}

async function handleSubscriberJsep(feedId, sub, jsep) {
  try {
    log(`JSEP (offer) per subscriber feed=${feedId}, creo answer`);

    if (!sub.pc) {
      const pc = new RTCPeerConnection({ iceServers: [] });

      pc.onicecandidate = ev => {
        if (!ev.candidate) {
          sendJanus({
            janus: 'trickle',
            transaction: makeTxId(`trickle-end-sub-${feedId}`),
            session_id: sessionId,
            handle_id: sub.handleId,
            candidate: { completed: true },
          });
          return;
        }
        sendJanus({
          janus: 'trickle',
          transaction: makeTxId(`trickle-sub-${feedId}`),
          session_id: sessionId,
          handle_id: sub.handleId,
          candidate: ev.candidate,
        });
      };

      pc.ontrack = ev => {
        log(`Remote track per feed=${feedId}, kind=${ev.track.kind}`);

        if (!sub.videoEl) {
          const box = document.createElement('div');
          box.className = 'remoteBox';

          const label = document.createElement('label');
          label.textContent = `Feed ${feedId} (${sub.display})`;

          const vid = document.createElement('video');
          vid.autoplay = true;
          vid.playsInline = true;

          box.appendChild(label);
          box.appendChild(vid);
          els.remoteVideos.appendChild(box);

          sub.videoEl = vid;
        }
        if (!sub.videoEl.srcObject && ev.streams[0]) {
          sub.videoEl.srcObject = ev.streams[0];
        }
      };

      pc.oniceconnectionstatechange = () => {
        log(`pcSub[${feedId}] ICE state:`, pc.iceConnectionState);
      };

      sub.pc = pc;
    }

    // Set remote SDP da Janus
    await sub.pc.setRemoteDescription(new RTCSessionDescription(jsep));

    // Assicuriamo SFrame RX per questo feed
    await ensureRxPeerForFeed(sub);

    // Agganciamo i transform RX ai receiver reali (audio+video)
    const receivers = sub.pc.getReceivers();
    for (const r of receivers) {
      if (r.track && r.track.kind === 'audio') {
        attachReceiverTransform(r, 'audio', sub);
      } else if (r.track && r.track.kind === 'video') {
        attachReceiverTransform(r, 'video', sub);
      }
    }

    const answer = await sub.pc.createAnswer();
    await sub.pc.setLocalDescription(answer);

    sendJanus({
      janus: 'message',
      transaction: makeTxId(`start-sub-${feedId}`),
      session_id: sessionId,
      handle_id: sub.handleId,
      body: {
        request: 'start',
        room: Number(els.roomId.value) || 1234,
      },
      jsep: answer,
    });

    log(`Answer inviato per subscriber feed ${feedId}`);
  } catch (e) {
    console.error('handleSubscriberJsep err', e);
    log(`❌ handleSubscriberJsep err (feed=${feedId}):`, e.message || e);
  }
}

function removeSubscriber(feedId) {
  const sub = subscribers.get(feedId);
  if (!sub) return;

  if (sub.pc) {
    try { sub.pc.close(); } catch {}
    sub.pc = null;
  }
  if (sub.videoEl && sub.videoEl.parentNode) {
    sub.videoEl.parentNode.remove();
  }
  if (sub.rxPeer && sub.rxPeer.free) {
    try { sub.rxPeer.free(); } catch {}
  }

  subscribers.delete(feedId);
}

// ─────────────────────────────────────────────────────────────
// Connect / Hangup / Cleanup
// ─────────────────────────────────────────────────────────────

function connectAndJoinRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('WS già aperto');
    return;
  }

  const url = (els.wsUrl.value || '').trim() || 'ws://localhost:8188/';
  log('Connessione a Janus WS:', url);

  ws = new WebSocket(url, 'janus-protocol');

  ws.onopen = () => {
    log('WS aperto');
    const tx = makeTxId('create');
    sendJanus({
      janus: 'create',
      transaction: tx,
    });
  };

  ws.onmessage = onJanusMessage;

  ws.onclose = ev => {
    log(`WS chiuso (code=${ev.code}, reason=${ev.reason || 'n/a'})`);
    cleanup();
  };

  ws.onerror = e => {
    console.error('WS error', e);
    log('WS error (vedi console per dettagli)');
  };

  setConnectedUI(true);
}

function hangup() {
  try {
    if (pluginHandlePub && sessionId) {
      sendJanus({
        janus: 'message',
        transaction: makeTxId('leave-pub'),
        session_id: sessionId,
        handle_id: pluginHandlePub,
        body: { request: 'leave' },
      });
    }
  } catch {}

  if (ws) {
    try { ws.close(); } catch {}
  }
  cleanup();
}

function cleanup() {
  if (pcPub) {
    try { pcPub.close(); } catch {}
  }
  pcPub = null;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = null;
  els.localVideo.srcObject = null;

  for (const [feedId, sub] of subscribers) {
    if (sub.pc) {
      try { sub.pc.close(); } catch {}
    }
    if (sub.rxPeer && sub.rxPeer.free) {
      try { sub.rxPeer.free(); } catch {}
    }
  }
  subscribers.clear();
  els.remoteVideos.innerHTML = '';

  sessionId = null;
  pluginHandlePub = null;

  if (txPeer && txPeer.free) {
    try { txPeer.free(); } catch {}
  }
  txPeer = null;

  setConnectedUI(false);
}

// ─────────────────────────────────────────────────────────────
// Mic / Cam toggle (su stream locale)
// ─────────────────────────────────────────────────────────────

function toggleMic() {
  if (!localStream) {
    log('Nessun localStream, impossibile togglare mic');
    return;
  }
  const track = localStream.getAudioTracks()[0];
  if (!track) {
    log('Nessun audio track locale');
    return;
  }
  track.enabled = !track.enabled;
  els.btnToggleMic.textContent = track.enabled ? 'Mic OFF' : 'Mic ON';
  log('Mic ' + (track.enabled ? 'ON' : 'OFF'));
}

function toggleCam() {
  if (!localStream) {
    log('Nessun localStream, impossibile togglare cam');
    return;
  }
  const track = localStream.getVideoTracks()[0];
  if (!track) {
    log('Nessun video track locale');
    return;
  }
  track.enabled = !track.enabled;
  els.btnToggleCam.textContent = track.enabled ? 'Cam OFF' : 'Cam ON';
  log('Cam ' + (track.enabled ? 'ON' : 'OFF'));
}

// ─────────────────────────────────────────────────────────────
// Bind UI & init
// ─────────────────────────────────────────────────────────────

els.btnConnect.addEventListener('click', connectAndJoinRoom);
els.btnHangup.addEventListener('click', hangup);
els.btnToggleMic.addEventListener('click', toggleMic);
els.btnToggleCam.addEventListener('click', toggleCam);

setConnectedUI(false);
log('Janus VideoRoom + SFrame app pronta. 1) Lancia docker Janus. 2) Avvia python -m http.server. 3) Apri http://localhost:5174/appRoom.html su più dispositivi e premi Connect.');
