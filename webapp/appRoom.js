// appRoom.js
// Janus VideoRoom multi-dispositivo (clear, senza SFrame per ora)

const els = {
  wsUrl: document.getElementById('wsUrl'),
  roomId: document.getElementById('roomId'),
  displayName: document.getElementById('displayName'),
  btnConnect: document.getElementById('btnConnect'),
  btnHangup: document.getElementById('btnHangup'),
  localVideo: document.getElementById('localVideo'),
  remoteVideos: document.getElementById('remoteVideos'),
  log: document.getElementById('log'),
};

function log(...a) {
  els.log.value += a.map(String).join(' ') + '\n';
  els.log.scrollTop = els.log.scrollHeight;
}

// Stato Janus
let ws = null;
let sessionId = null;

// Handle per il PUBLISHER (noi)
let pluginHandlePub = null;

// RTCPeerConnection per pubblicare
let pcPub = null;
let localStream = null;

// Mappa: feedId -> info subscriber
// { handleId, pc, videoEl }
const subscribers = new Map();

function setConnectedUI(connected) {
  els.btnConnect.disabled = connected;
  els.btnHangup.disabled = !connected;
}

/** Utility transaction id semplice */
function makeTxId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Spedisce un messaggio a Janus via WS */
function sendJanus(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log('⚠️ WebSocket non aperto, impossibile inviare:', JSON.stringify(msg));
    return;
  }
  ws.send(JSON.stringify(msg));
}

/** Gestione messaggi da Janus */
function onJanusMessage(evt) {
  let msg;
  try {
    msg = JSON.parse(evt.data);
  } catch (e) {
    console.warn('JSON err', e);
    return;
  }

  const { janus } = msg;

  // Debug raw opzionale
  // console.debug('Janus msg:', msg);

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

/** success = risposta a create/attach */
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

/** event = plugin data (videoroom) e/o jsep */
function handleJanusEvent(msg) {
  const sender = msg.sender;
  const plugindata = msg.plugindata;
  const jsep = msg.jsep;

  if (!plugindata || plugindata.plugin !== 'janus.plugin.videoroom') {
    return;
  }
  const data = plugindata.data || {};
  const vr = data.videoroom;

  // Eventi per il nostro handle publisher
  if (sender === pluginHandlePub) {
    if (vr === 'joined') {
      log('✅ Joined room come publisher. ID interno:', data.id);
      if (Array.isArray(data.publishers)) {
        log('Publisher già presenti:', data.publishers.map(p => p.display || p.id).join(', ') || '(nessuno)');
        data.publishers.forEach(p => {
          subscribeToPublisher(p.id, p.display);
        });
      }
      // Quando abbiamo "joined", facciamo l'offer e mandiamo "publish"
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

    // jsep di risposta alla nostra publish
    if (jsep && pcPub) {
      log('Ricevuto JSEP answer per publisher');
      pcPub.setRemoteDescription(new RTCSessionDescription(jsep)).catch(e => {
        console.error('setRemoteDescription(pub) err', e);
        log('❌ setRemoteDescription(pub) err:', e.message || e);
      });
    }
    return;
  }

  // Eventi per subscriber handle (uno per ogni feed)
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

/** ICE dai subscriber */
function handleJanusTrickle(msg) {
  const sender = msg.sender;
  const c = msg.candidate;
  if (!c) return;

  // Qui potremmo gestire ICE da Janus, ma in genere Janus manda ICE via jsep.
  // Per semplicità, ignoriamo (o in futuro gestiamo per compatibilità completa).
  // log('Trickle da Janus per handle', sender, 'candidate:', JSON.stringify(c));
}

/** Attach videoroom come publisher */
function attachPublisherHandle() {
  const tx = makeTxId('attach-pub');
  sendJanus({
    janus: 'attach',
    plugin: 'janus.plugin.videoroom',
    transaction: tx,
    session_id: sessionId,
  });
}

/** Join come publisher nella stanza */
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

/** Crea pcPub, gUM, Offer + publish */
async function startPublishing() {
  try {
    const room = Number(els.roomId.value) || 1234;
    log('Avvio publish nella room', room);

    pcPub = new RTCPeerConnection({ iceServers: [] });

    pcPub.onicecandidate = (ev) => {
      if (!ev.candidate) {
        // fine candidates
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

    // getUserMedia
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = localStream;

    localStream.getTracks().forEach(t => pcPub.addTrack(t, localStream));

    const offer = await pcPub.createOffer();
    await pcPub.setLocalDescription(offer);

    // Richiesta publish con jsep = offer
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

/** Avvia sottoscrizione a un publisher (feed) */
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

/** Join come subscriber su un handle (dopo attach) */
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

/** Gestisce la JSEP (offer) inviata da Janus al subscriber */
async function handleSubscriberJsep(feedId, info, jsep) {
  try {
    log(`JSEP (offer) per subscriber feed=${feedId}, creo answer`);

    // Se non abbiamo ancora pc, creiamola
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

/** Rimuove subscriber alla disconnessione del publisher */
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
  subscribers.delete(feedId);
}

/** Connect + create session */
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

/** Hangup / cleanup completo */
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
  }
  subscribers.clear();
  els.remoteVideos.innerHTML = '';

  sessionId = null;
  pluginHandlePub = null;

  setConnectedUI(false);
}

// Bind UI
els.btnConnect.addEventListener('click', connectAndJoinRoom);
els.btnHangup.addEventListener('click', hangup);

setConnectedUI(false);
log('Janus VideoRoom app pronta. 1) Lancia docker Janus. 2) Avvia python -m http.server. 3) Apri http://localhost:5174/appRoom.html su più dispositivi e premi Connect.');
