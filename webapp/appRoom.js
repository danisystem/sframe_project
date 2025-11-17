// appRoom.js
// Janus VideoRoom multi-dispositivo + SFrame (Insertable Streams)

// ─────────────────────────────────────────────────────────────
// Import HKDF per derivare le chiavi per-mittente
// ─────────────────────────────────────────────────────────────
import { hkdf } from './hkdf.js';

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

// ─────────────────────────────────────────────────────────────
// SFrame parameters
// ─────────────────────────────────────────────────────────────
const KID_AUDIO = 1;
const KID_VIDEO = 2;
const BASE_SECRET = new TextEncoder().encode('DEV-ONLY-BASE-SECRET');

// TX: un solo peer per cifrare i nostri frame
let txPeer = null;

// Stato Janus
let ws = null;
let sessionId = null;

// Handle per il PUBLISHER (noi)
let pluginHandlePub = null;

// RTCPeerConnection per pubblicare
let pcPub = null;
let localStream = null;

// Mappa: feedId -> info subscriber
// info: { feedId, display, handleId, pc, videoEl, rxPeer, audioTransceiver, videoTransceiver }
const subscribers = new Map();

// ─────────────────────────────────────────────────────────────
// Helpers generali
// ─────────────────────────────────────────────────────────────

function makeTxId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function sendJanus(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('⚠️ WebSocket non aperto, impossibile inviare:', JSON.stringify(msg));
    return;
  }
  ws.send(JSON.stringify(msg));
}

// ─────────────────────────────────────────────────────────────
// SFrame helpers
// ─────────────────────────────────────────────────────────────

async function ensureTxPeerForLocal() {
  if (txPeer) return true;
  if (!window.SFRAME?.WasmPeer) {
    log('⚠️ SFRAME non pronto (WasmPeer mancante), TX in chiaro.');
    return false;
  }
  let disp = els.displayName.value.trim();
  if (!disp) {
    disp = 'user-' + Math.random().toString(36).slice(2, 8);
    els.displayName.value = disp;
  }
  try {
    const secret = await hkdf(BASE_SECRET, `sender=${disp}`);
    txPeer = new window.SFRAME.WasmPeer(
      KID_AUDIO,  // kid audio
      KID_VIDEO,  // kid video
      null,
      secret
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

async function ensureRxPeerForFeed(info) {
  if (info.rxPeer) return true;
  if (!window.SFRAME?.WasmPeer) {
    log(`⚠️ SFRAME non pronto (RX), feed=${info.feedId}, RX in chiaro.`);
    return false;
  }
  const label = info.display || String(info.feedId);
  try {
    const secret = await hkdf(BASE_SECRET, `sender=${label}`);
    info.rxPeer = window.SFRAME.WasmPeer.new_full_duplex(
      99, 98,          // tx dummy
      KID_AUDIO,
      KID_VIDEO,
      null,
      secret
    );
    log(`SFrame RX peer pronto per feed=${info.feedId} (${label})`);
    return true;
  } catch (e) {
    console.error('ensureRxPeerForFeed err', e);
    log(`⚠️ Errore inizializzazione RX peer per feed=${info.feedId}, RX in chiaro.`);
    info.rxPeer = null;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Encoded transforms – TX
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Encoded transforms – RX (per ogni feed)
// ─────────────────────────────────────────────────────────────

function attachReceiverTransform(receiver, kind, info) {
  if (!receiver) {
    log('attachReceiverTransform: receiver mancante per', kind, 'feed=', info.feedId);
    return;
  }
  if (typeof receiver.createEncodedStreams !== 'function') {
    log('⚠️ receiver.createEncodedStreams non disponibile per ' + kind + ' feed=' + info.feedId);
    return;
  }

  let streams;
  try {
    streams = receiver.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(RX) ha lanciato su ' + kind + ' feed=' + info.feedId + ': ' + (e.message || e));
    console.warn('createEncodedStreams receiver error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform RX attaccato su', kind, 'feed=', info.feedId);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!info.rxPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);

        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const hdrInfo = window.SFRAME.inspect(inU8);
            log(`[RX/${kind} feed=${info.feedId}] ${hdrInfo}`);
          } catch {}
        }

        let outU8;
        if (kind === 'audio') {
          outU8 = info.rxPeer.decrypt_audio(inU8);
        } else {
          outU8 = info.rxPeer.decrypt_video(inU8);
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

// ─────────────────────────────────────────────────────────────
// Gestione messaggi Janus
// ─────────────────────────────────────────────────────────────

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

function handleJanusSuccess(msg) {
  const { transaction, data } = msg;

  if (transaction && transaction.startsWith('create-')) {
    sessionId = data.id;
    log('Session ID:', sessionId);
    attachPublisherHandle();
  } else if (transaction && transaction.startsWith('attach-pub-')) {
    pluginHandlePub = data.id;
    log('Publisher handle ID:', pluginHandlePub);
    joinAsPublisher();
  } else if (transaction && transaction.startsWith('attach-sub-')) {
    const feedIdStr = transaction.split('attach-sub-')[1];
    const feedId = Number(feedIdStr);
    const info = subscribers.get(feedId);
    if (info) {
      info.handleId = data.id;
      log(`Subscriber handle per feed ${feedId}:`, info.handleId);
      joinAsSubscriber(feedId, info.handleId);
    }
  }
}

function handleJanusEvent(msg) {
  const sender = msg.sender;
  const plugindata = msg.plugindata;
  const jsep = msg.jsep;

  if (!plugindata || plugindata.plugin !== 'janus.plugin.videoroom') {
    return;
  }
  const data = plugindata.data || {};
  const vr = data.videoroom;

  if (sender === pluginHandlePub) {
    if (vr === 'joined') {
      log('✅ Joined room come publisher. ID interno:', data.id);
      if (Array.isArray(data.publishers)) {
        log('Publisher già presenti:', data.publishers.map(p => p.display || p.id).join(', ') || '(nessuno)');
        data.publishers.forEach(p => {
          subscribeToPublisher(p.id, p.display);
        });
      }
      startPublishing();
    } else if (vr === 'event') {
      if (Array.isArray(data.publishers)) {
        data.publishers.forEach(p => {
          log('Nuovo publisher nella room:', p.display || p.id);
          subscribeToPublisher(p.id, p.display);
        });
      }
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

  for (const [feedId, info] of subscribers.entries()) {
    if (info.handleId === sender) {
      if (vr === 'attached') {
        log(`Subscriber attached per feed ${feedId}`);
      }
      if (jsep) {
        handleSubscriberJsep(feedId, info, jsep);
      }
      break;
    }
  }
}

function handleJanusTrickle(msg) {
  const c = msg.candidate;
  if (!c) return;
  // Per semplicità non gestiamo le trickle da Janus (spesso bastano quelle via JSEP)
}

// ─────────────────────────────────────────────────────────────
// Publisher
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
  let disp = els.displayName.value.trim();
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

    pcPub.onicecandidate = (ev) => {
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

    // SFrame TX: prepara il WasmPeer
    const sframeOk = await ensureTxPeerForLocal();
    if (!sframeOk) {
      log('⚠️ SFrame TX non attivo: invieremo in chiaro (solo SRTP).');
    }

    // Media locale
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = localStream;

    els.btnToggleMic.textContent = 'Mic OFF';
    els.btnToggleCam.textContent = 'Cam OFF';

    // Audio
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      const sender = pcPub.addTrack(audioTrack, localStream);
      if (sframeOk) attachSenderTransform(sender, 'audio');
    }

    // Video
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = pcPub.addTrack(videoTrack, localStream);
      if (sframeOk) attachSenderTransform(sender, 'video');
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
// Subscriber
// ─────────────────────────────────────────────────────────────

function subscribeToPublisher(feedId, display) {
  if (subscribers.has(feedId)) {
    return;
  }
  const info = {
    feedId,
    display: display || String(feedId),
    handleId: null,
    pc: null,
    videoEl: null,
    rxPeer: null,
    audioTransceiver: null,
    videoTransceiver: null,
  };
  subscribers.set(feedId, info);

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

async function handleSubscriberJsep(feedId, info, jsep) {
  try {
    log(`JSEP (offer) per subscriber feed=${feedId}, creo answer`);

    if (!info.pc) {
      const pc = new RTCPeerConnection({ iceServers: [] });

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          sendJanus({
            janus: 'trickle',
            transaction: makeTxId(`trickle-end-sub-${feedId}`),
            session_id: sessionId,
            handle_id: info.handleId,
            candidate: { completed: true },
          });
          return;
        }
        sendJanus({
          janus: 'trickle',
          transaction: makeTxId(`trickle-sub-${feedId}`),
          session_id: sessionId,
          handle_id: info.handleId,
          candidate: ev.candidate,
        });
      };

      pc.ontrack = (ev) => {
        log(`Remote track per feed=${feedId}, kind=${ev.track.kind}`);
        if (!info.videoEl) {
          const box = document.createElement('div');
          box.className = 'remoteBox';
          const label = document.createElement('label');
          label.textContent = `Feed ${feedId} (${info.display})`;
          const vid = document.createElement('video');
          vid.autoplay = true;
          vid.playsInline = true;

          box.appendChild(label);
          box.appendChild(vid);
          els.remoteVideos.appendChild(box);

          info.videoEl = vid;
        }
        if (!info.videoEl.srcObject) {
          info.videoEl.srcObject = ev.streams[0];
        }
      };

      pc.oniceconnectionstatechange = () => {
        log(`pcSub[${feedId}] ICE state:`, pc.iceConnectionState);
      };

      info.pc = pc;

      // SFrame RX peer per questo feed
      await ensureRxPeerForFeed(info);

      // Pre-creiamo transceiver recvonly audio/video e
      // attacchiamo SUBITO i transform RX
      info.audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      info.videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });

      if (info.rxPeer) {
        attachReceiverTransform(info.audioTransceiver.receiver, 'audio', info);
        attachReceiverTransform(info.videoTransceiver.receiver, 'video', info);
      } else {
        log(`⚠️ Nessun RX peer per feed=${feedId}: RX in chiaro.`);
      }
    }

    await info.pc.setRemoteDescription(new RTCSessionDescription(jsep));
    const answer = await info.pc.createAnswer();
    await info.pc.setLocalDescription(answer);

    sendJanus({
      janus: 'message',
      transaction: makeTxId(`start-sub-${feedId}`),
      session_id: sessionId,
      handle_id: info.handleId,
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
  const info = subscribers.get(feedId);
  if (!info) return;

  if (info.pc) {
    try { info.pc.close(); } catch {}
    info.pc = null;
  }
  if (info.videoEl && info.videoEl.parentNode) {
    info.videoEl.parentNode.remove();
  }
  if (info.rxPeer && info.rxPeer.free) {
    try { info.rxPeer.free(); } catch {}
  }

  subscribers.delete(feedId);
}

// ─────────────────────────────────────────────────────────────
// Connect / Hangup
// ─────────────────────────────────────────────────────────────

function connectAndJoinRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('WS già aperto');
    return;
  }

  const url = els.wsUrl.value.trim() || 'ws://localhost:8188/';
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

  ws.onclose = (ev) => {
    log(`WS chiuso (code=${ev.code}, reason=${ev.reason || 'n/a'})`);
    cleanup();
  };

  ws.onerror = (e) => {
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

  for (const [feedId, info] of subscribers) {
    if (info.pc) {
      try { info.pc.close(); } catch {}
    }
    if (info.rxPeer && info.rxPeer.free) {
      try { info.rxPeer.free(); } catch {}
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
// Mic / Cam
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
