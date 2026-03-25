// appRoom.js
// ─────────────────────────────────────────────────────────────
// Janus VideoRoom + SFrame + MLS E2EE – multi-room con invite link
// ─────────────────────────────────────────────────────────────

// Moduli UI / log
import { els, setConnectedUI, isSFrameLogEnabled } from "./ui.js";
import { Output } from "./output.js";

// MLS → segreti + mapping index/identity + KID
import {
  mlsJoin,
  mlsFetchRoster,
  mlsResync, // ← resync epoch / welcome
  deriveTxKey,
  deriveRxKey,
  computeKid,
  attachIndexToIdentity,
  parseIdentityWithIndex,
} from "./mls_sframe_session.js";

// Layer SFrame (wrapper attorno a WasmPeer di sframe_core)
import {
  initSFrame,
  createTxPeer,
  createRxPeer,
} from "./sframe_layer.js";

// 🔹 FUNZIONI WASM PER GLI HEADER SFRAME
import {
  sframe_last_tx_header,
  sframe_last_rx_header,
} from "./pkg/sframe_core.js";

// ─────────────────────────────────────────────────────────────
// Stato globale
// ─────────────────────────────────────────────────────────────

let ws = null;
let sessionId = null;
let pluginHandlePub = null;
let pcPub = null;
let keepaliveTimer = null;
let mlsHeartbeatTimer = null; // 🔴 NUOVO: Timer per controllare i Welcome/Epoch
let localStream = null;

// Info MLS per questo peer:
// { sender_index, epoch, room_id, master_secret, roster, is_creator }
let mlsInfo = null;

// Identity “base” (senza #index MLS)
let myIdentity = null;

// Ref mutabile al TX peer SFrame: { peer: WasmPeer } oppure null
let txPeerRef = null;

// feedId → {feedId, display, pc, rxPeerRef, videoEl, handleId, receivers}
const subscribers = new Map();

// throttling error per RX decrypt (per non spammare log)
let lastRxDecryptErrorTs = 0;

// stato di "key sync in corso"
let keySyncInProgress = false;

// 🔴 FIX LOOP: Variabile per evitare sovrapposizioni (il "lucchetto")
let isResyncing = false;

// ─────────────────────────────────────────────────────────────
// Utility UI: overlay “syncing keys” + toast stile Zoom
// ─────────────────────────────────────────────────────────────

function ensureKeySyncOverlay() {
  let overlay = document.getElementById("keySyncOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "keySyncOverlay";
    overlay.style.position = "fixed";
    overlay.style.top = "10px";
    overlay.style.right = "10px";
    overlay.style.zIndex = "9999";
    overlay.style.background = "rgba(15,23,42,0.9)";
    overlay.style.color = "#e5e7eb";
    overlay.style.padding = "8px 12px";
    overlay.style.borderRadius = "999px";
    overlay.style.fontSize = "12px";
    overlay.style.display = "none";
    overlay.style.boxShadow = "0 4px 12px rgba(0,0,0,0.4)";
    overlay.style.pointerEvents = "none";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function setKeySyncInProgress(active, reason) {
  keySyncInProgress = active;
  const overlay = ensureKeySyncOverlay();
  if (active) {
    overlay.textContent = reason
      ? `🔐 Syncing encryption keys… (${reason})`
      : "🔐 Syncing encryption keys…";
    overlay.style.display = "block";
  } else {
    overlay.style.display = "none";
  }
}

// Toast container stile Zoom “X si è unito”
function ensureToastContainer() {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.position = "fixed";
    container.style.bottom = "16px";
    container.style.left = "50%";
    container.style.transform = "translateX(-50%)";
    container.style.zIndex = "9998";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "8px";
    container.style.pointerEvents = "none";
    document.body.appendChild(container);
  }
  return container;
}

function showJoinToast(display) {
  const container = ensureToastContainer();
  const { identity } = parseIdentityWithIndex(display || "");
  const name = identity || display || "Unknown";

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.style.background = "rgba(15,23,42,0.95)";
  toast.style.color = "#e5e7eb";
  toast.style.padding = "6px 10px";
  toast.style.borderRadius = "999px";
  toast.style.fontSize = "13px";
  toast.style.boxShadow = "0 4px 14px rgba(0,0,0,0.5)";
  toast.style.opacity = "1";
  toast.style.transition = "opacity 0.4s ease-out";

  toast.textContent = `👤 ${name} si è unito alla stanza`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 400);
  }, 1800);
}

// ─────────────────────────────────────────────────────────────
// Feature detection: SFrame / Insertable Streams
// ─────────────────────────────────────────────────────────────

function isSFrameSupported() {
  try {
    const hasRTCRtpSender =
      typeof RTCRtpSender !== "undefined" &&
      RTCRtpSender.prototype &&
      typeof RTCRtpSender.prototype.createEncodedStreams === "function";

    const hasTransformStream = typeof TransformStream !== "undefined";

    const supported = hasRTCRtpSender && hasTransformStream;
    Output.sframe("SFrame support check", {
      hasRTCRtpSender,
      hasTransformStream,
      supported,
      userAgent: navigator.userAgent,
    });
    return supported;
  } catch (e) {
    Output.error("SFrame support detection failed", e);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Utilità generali
// ─────────────────────────────────────────────────────────────

function sendJanus(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function makeTxId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    if (!sessionId || ws.readyState !== WebSocket.OPEN) return;
    sendJanus({
      janus: "keepalive",
      transaction: makeTxId("keepalive"),
      session_id: sessionId,
    });
  }, 25000);
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

// 🔴 NUOVO: Heartbeat E2EE per gestire inviti e cambi Epoch
function startMlsHeartbeat() {
    if (mlsHeartbeatTimer) return;
    mlsHeartbeatTimer = setInterval(() => {
        if (!mlsInfo || !myIdentity) return;
        const room = Number(els.roomId.value);
        if (!Number.isFinite(room) || room <= 0) return;

        // 🔴 FIX LOOP: Se c'è già un sync in corso, salta il turno
        if (isResyncing) return;
        isResyncing = true; // Chiudo il lucchetto

        // Eseguiamo un resync silenzioso in background
        mlsResync(myIdentity, room, mlsInfo).then(({ changed, info }) => {
            if (changed) {
                Output.mls("Heartbeat ha rilevato un aggiornamento della stanza!", { oldEpoch: mlsInfo.epoch, newEpoch: info.epoch });
                mlsInfo = info;
                refreshRosterUI();
                
                // Se l'epoch è cambiata e abbiamo un master_secret valido, rigeneriamo le chiavi
                if (mlsInfo.master_secret) {
                    rekeyAllPeers();
                }
            }
        }).catch(e => {
            // Non spammare log d'errore per il background polling
        }).finally(() => {
            isResyncing = false; // 🔴 FIX LOOP: Riapro il lucchetto
        });
    }, 5000); // Ogni 5 secondi
}

function stopMlsHeartbeat() {
    if (mlsHeartbeatTimer) clearInterval(mlsHeartbeatTimer);
    mlsHeartbeatTimer = null;
}

// UI: lista “Remote peers”
function renderRemotePeers(roster, identityMe) {
  const box = document.getElementById("remotePeers");
  if (!box) return;

  box.innerHTML = "";

  roster.forEach(m => {
    if (m.identity === "server") return;
    if (m.identity === identityMe) return;

    const div = document.createElement("div");
    div.textContent = `${m.index}: ${m.identity}`;
    box.appendChild(div);
  });
}

// Chiede al backend MLS il roster aggiornato e refresh della UI
async function refreshRosterUI() {
  if (!myIdentity) return;

  const room = Number(els.roomId.value);
  if (!Number.isFinite(room) || room <= 0) return;

  try {
    const r = await mlsFetchRoster(room);
    renderRemotePeers(r.roster, myIdentity);
  } catch (e) {
    Output.error("MLS roster refresh failed", e);
  }
}

// ─────────────────────────────────────────────────────────────
// MLS resync + rekey
// ─────────────────────────────────────────────────────────────

// Resync MLS manuale: controlla se l'epoch è cambiata e, se sì, rekey SFrame
async function maybeResyncMls(reason) {
  if (!mlsInfo || !myIdentity) return;

  const room = Number(els.roomId.value);
  if (!Number.isFinite(room) || room <= 0) return;

  // 🔴 FIX LOOP: Evita richieste multiple simultanee
  if (isResyncing) return;
  isResyncing = true;

  setKeySyncInProgress(true, reason);

  try {
    // 🔴 FIX LOOP: Ritardo casuale per evitare che tutti colpiscano il server insieme
    const jitter = Math.floor(Math.random() * 1500) + 500;
    await new Promise(resolve => setTimeout(resolve, jitter));

    // ⏱️ START: Inizio calcolo MLS per aggiornamento Epoca
    const t0 = performance.now();
    
    const { changed, info } = await mlsResync(myIdentity, room, mlsInfo);
    
    // ⏱️ STOP: Fine calcolo MLS
    const t1 = performance.now();

    if (!changed) {
      return; // Non c'è nulla di nuovo
    }

    const timeMs = (t1 - t0).toFixed(2);
    console.log(`📊 [BENCHMARK VERO MLS] Aggiornamento Epoca (${reason}): ${timeMs} ms`);

    Output.mls("MLS epoch CHANGED", {
      reason,
      oldEpoch: mlsInfo.epoch,
      newEpoch: info.epoch,
    });

    mlsInfo = info;
    
    if (mlsInfo.master_secret) {
        await rekeyAllPeers();
    }
  } catch (e) {
    Output.error("MLS resync failed", { reason, error: e });
  } finally {
    setKeySyncInProgress(false, reason);
    isResyncing = false; // 🔴 FIX LOOP: Riapro il lucchetto
  }
}

// Rigenera chiavi/KID e aggiorna i peer SFrame TX/RX
async function rekeyAllPeers() {
  if (!mlsInfo || !mlsInfo.master_secret) return;

  const room = Number(els.roomId.value);
  if (!Number.isFinite(room) || room <= 0) return;

  // TX
  if (pcPub && localStream && txPeerRef) {
    try {
      const selfIndex = mlsInfo.sender_index;
      const txKey = await deriveTxKey(mlsInfo.master_secret, selfIndex);
      const kidAudio = computeKid(mlsInfo.epoch, room, selfIndex);
      const kidVideo = kidAudio + 1;

      txPeerRef.peer = createTxPeer(kidAudio, kidVideo, txKey);
    } catch (e) {
      Output.error("TX rekey failed", e);
    }
  }

  // RX
  for (const [feedId, sub] of subscribers.entries()) {
    try {
      const { senderIndex: remoteIndex } = parseIdentityWithIndex(sub.display || "");
      if (remoteIndex == null) continue;

      const rxKey = await deriveRxKey(mlsInfo.master_secret, remoteIndex);
      
      // 🔴=============================================================
      // 🔴 PROVA DEL NOVE: IL SABOTAGGIO DELLA CHIAVE
      // 🔴 Cambia "false" in "true" per rompere apposta la cifratura!
      // 🔴=============================================================
      const SABOTA_CHIAVE = false; 

      let chiaveFinale = rxKey;
      if (SABOTA_CHIAVE) {
          console.error("☠️ ATTENZIONE: MODALITÀ SABOTAGGIO ATTIVA! La chiave è stata corrotta apposta.");
          chiaveFinale = new Uint8Array(rxKey);
          chiaveFinale[0] = chiaveFinale[0] ^ 0xFF; // Inverto i bit del primo byte!
      }

      const kidAudio = computeKid(mlsInfo.epoch, room, remoteIndex);
      const kidVideo = kidAudio + 1;

      sub.rxPeerRef = sub.rxPeerRef || {};
      sub.rxPeerRef.peer = createRxPeer(99, 98, kidAudio, kidVideo, chiaveFinale);

      // Fix per lo sblocco del video (richieste Keyframe multiple)
      const askForKeyframeRekey = () => {
        if (sub.handleId && sessionId) {
          sendJanus({
            janus: "message",
            transaction: makeTxId(`force-kf-rekey-${feedId}`),
            session_id: sessionId,
            handle_id: sub.handleId,
            body: { request: "configure", keyframe: true }
          });
        }
      };

      setTimeout(askForKeyframeRekey, 200);
      setTimeout(askForKeyframeRekey, 1000);
      setTimeout(askForKeyframeRekey, 2500);

    } catch (e) {
      Output.error("RX rekey failed", { feedId, error: e });
    }
  }
}
// ─────────────────────────────────────────────────────────────
// UI: Room + invite link
// ─────────────────────────────────────────────────────────────

function updateRoomUI(roomId) {
  const room = Number(roomId);
  if (!Number.isFinite(room) || room <= 0) return;

  if (els.roomId) {
    els.roomId.value = String(room);
    els.roomId.readOnly = true;
  }

  const inviteInput = document.getElementById("inviteLink");
  const copyBtn = document.getElementById("btnCopyInvite");

  if (inviteInput) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", String(room));
    inviteInput.value = url.toString();
  }

  if (copyBtn && inviteInput) {
    copyBtn.onclick = () => {
      inviteInput.select();
      try {
        navigator.clipboard?.writeText(inviteInput.value);
      } catch (_) {
        // se clipboard fallisce, resta comunque selezionato
      }
    };
  }
}

// All’avvio pagina: prende room da URL oppure crea nuova stanza
async function setupRoomOnLoad() {
  const url = new URL(window.location.href);
  let roomFromUrl = url.searchParams.get("room");

  if (roomFromUrl) {
    const room = Number(roomFromUrl);
    if (!Number.isFinite(room) || room <= 0) {
      Output.error("Invalid room in URL, cannot join");
      return;
    }
    Output.ui("Room from URL", { room });
    updateRoomUI(room);
    return;
  }

  Output.ui("No room in URL -> creating new room...", {});
  try {
    const res = await fetch("/api/new-room", { method: "POST" });
    const json = await res.json();

    if (!res.ok || !json.roomId) {
      throw new Error("Bad response from /api/new-room");
    }

    const room = Number(json.roomId);

    url.searchParams.set("room", String(room));
    window.history.replaceState(null, "", url.toString());

    Output.ui("New room created", { room });
    updateRoomUI(room);
  } catch (e) {
    Output.error("Cannot create room", e);
  }
}

// ─────────────────────────────────────────────────────────────
// Helper: chiedere la lista completa dei partecipanti
// ─────────────────────────────────────────────────────────────

function requestParticipantsList() {
  const room = Number(els.roomId.value);
  if (!Number.isFinite(room) || room <= 0) return;
  if (!sessionId || !pluginHandlePub) return;

  Output.janus("Requesting participants list", { room });

  sendJanus({
    janus: "message",
    transaction: makeTxId("listparticipants"),
    session_id: sessionId,
    handle_id: pluginHandlePub,
    body: {
      request: "listparticipants",
      room,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// WS → Janus
// ─────────────────────────────────────────────────────────────

function onJanusMessage(evt) {
  let msg;
  try {
    msg = JSON.parse(evt.data);
  } catch {
    return;
  }

  const { janus } = msg;

  if (janus === "success") return handleSuccess(msg);
  if (janus === "event") return handleEvent(msg);
  if (janus === "trickle") return;
  if (janus === "webrtcup") return Output.janus("WebRTC UP", msg.sender);
  if (janus === "hangup") return Output.janus("Hangup", msg.reason);
  if (janus === "error") return Output.error("Janus Error", msg.error);
}

// ─────────────────────────────────────────────────────────────
// SUCCESS
// ─────────────────────────────────────────────────────────────

function handleSuccess(msg) {
  const { transaction, data } = msg;

  // Session create
  if (transaction?.startsWith("create-")) {
    sessionId = data.id;
    Output.janus("Session created", sessionId);
    startKeepalive();
    attachPublisherHandle();
    return;
  }

  // Attach Publisher
  if (transaction?.startsWith("attach-pub-")) {
    pluginHandlePub = data.id;
    Output.janus("Publisher handle", pluginHandlePub);
    // join MLS + VideoRoom (async)
    joinAsPublisher();
    return;
  }

  // Attach Subscriber
  if (transaction?.startsWith("attach-sub-")) {
    const feedId = Number(transaction.split("attach-sub-")[1]);
    const sub = subscribers.get(feedId);
    if (sub) {
      sub.handleId = data.id;
      joinAsSubscriber(feedId, sub.handleId);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// EVENT
// ─────────────────────────────────────────────────────────────

function handleEvent(msg) {
  const { sender, plugindata, jsep } = msg;

  if (!plugindata || plugindata.plugin !== "janus.plugin.videoroom") return;
  const data = plugindata.data || {};
  const vr = data.videoroom;

  if (vr === "participants" && Array.isArray(data.participants)) {
    const room = data.room;
    const parts = data.participants.filter(p => p.publisher);

    Output.janus("Participants list", {
      room,
      participants: parts.map(p => ({ id: p.id, display: p.display })),
    });

    parts.forEach(p => {
      const { identity: name } = parseIdentityWithIndex(p.display || "");
      if (name === myIdentity) return;
      subscribeToPublisher(p.id, p.display);
    });

    maybeResyncMls("participants-list").catch(() => {});
  }

  // Eventi per il nostro Publisher
  if (sender === pluginHandlePub) {
    if (vr === "joined") {
      Output.janus("Joined as publisher", data.id);
      if (Array.isArray(data.publishers)) {
        data.publishers.forEach(p => subscribeToPublisher(p.id, p.display));
      }
      refreshRosterUI().catch(() => {});
      
      // Inizia a trasmettere solo quando il join di Janus è completo
      startPublishing().catch(e => {
        Output.error("startPublishing error (joined)", e);
      });
      requestParticipantsList();
      return;
    }

    if (vr === "event") {
      if (Array.isArray(data.publishers)) {
        maybeResyncMls("new-publishers").finally(() => {
          data.publishers.forEach(p => {
            subscribeToPublisher(p.id, p.display);
            showJoinToast(p.display || `Feed ${p.id}`);
          });
          refreshRosterUI().catch(() => {});
        });
      }

      if (data.configured === "ok") {
        requestParticipantsList();
      }
    }

    if (data.unpublished) {
      const fid = Number(data.unpublished);
      if (Number.isFinite(fid)) {
        removeSubscriber(fid);
        maybeResyncMls("unpublished").catch(() => {});
        refreshRosterUI().catch(() => {});
      }
    }
    if (data.leaving) {
      const fid = Number(data.leaving);
      if (Number.isFinite(fid)) {
        removeSubscriber(fid);
        maybeResyncMls("leaving").catch(() => {});
        refreshRosterUI().catch(() => {});
      }
    }

    if (jsep) {
      pcPub.setRemoteDescription(new RTCSessionDescription(jsep));
    }
    return;
  }

  // Eventi per i Subscriber
  for (const [feedId, sub] of subscribers.entries()) {
    if (sub.handleId === sender) {
      if (jsep) handleSubscriberJsep(feedId, sub, jsep);
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// NUOVO: La Sala d'Attesa E2EE
// ─────────────────────────────────────────────────────────────
async function waitForWelcome(room) {
    setKeySyncInProgress(true, "Waiting for Welcome");
    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            Output.ui("Polling per il Welcome message...");
            try {
                // 🔴 FIX LOOP: Chiudiamo momentaneamente il lucchetto solo in questa funzione per evitare log
                if (isResyncing) return;
                isResyncing = true;

                // ⏱️ START: Inizio VERO calcolo asimmetrico (WASM MLS + ECDH)
                const tMlsStart = performance.now();
                
                const resyncData = await mlsResync(myIdentity, room, mlsInfo);
                
                // ⏱️ STOP: Fine calcolo
                const tMlsEnd = performance.now();
                
                isResyncing = false; // Riapro il lucchetto

                if (resyncData.changed && resyncData.info.master_secret) {
                    clearInterval(interval);
                    mlsInfo = resyncData.info;
                    
                    const timeMs = (tMlsEnd - tMlsStart).toFixed(2);
                    console.log(`📊 [BENCHMARK VERO MLS] Decifratura Welcome (ECDH + OpenMLS): ${timeMs} ms`);
                    
                    setKeySyncInProgress(false);
                    Output.ui(`✅ Welcome ricevuto e decifrato in ${timeMs} ms! Entro nella stanza.`);
                    resolve();
                }
            } catch (e) {
                isResyncing = false;
                Output.error("Errore durante l'attesa del Welcome", e);
            }
        }, 3000); 
    });
}

// ─────────────────────────────────────────────────────────────
// Publisher
// ─────────────────────────────────────────────────────────────

function attachPublisherHandle() {
  sendJanus({
    janus: "attach",
    plugin: "janus.plugin.videoroom",
    transaction: makeTxId("attach-pub"),
    session_id: sessionId,
  });
}

// Join come publisher: MLS JOIN → identity#sender_index → join Janus
async function joinAsPublisher() {
  const room = Number(els.roomId.value);

  if (!Number.isFinite(room) || room <= 0) {
    Output.error("No valid roomId, cannot join");
    return;
  }

  myIdentity = els.displayName.value.trim() || ("user-" + crypto.randomUUID());

  try {
    // Carica WASM
    await initSFrame(); 

    if (!mlsInfo) {
      mlsInfo = await mlsJoin(myIdentity, room);
      Output.mls("MLS JOIN OK", Object.assign({}, mlsInfo, { master_secret: mlsInfo.master_secret ? "HIDDEN" : null }));
      renderRemotePeers(mlsInfo.roster, myIdentity);
    }

    // 🔴 LA SALA D'ATTESA! Se non abbiamo il segreto, blocchiamo tutto finché non arriva!
    if (!mlsInfo.master_secret) {
        Output.ui("In attesa dell'invito crittografato dal creatore della stanza...");
        await waitForWelcome(room);
    }

    // Avvia l'heartbeat per gestire futuri utenti o aggiornamenti
    startMlsHeartbeat();

    const fullIdentity = attachIndexToIdentity(myIdentity, mlsInfo.sender_index);

    Output.ui("Join as publisher", { room, identity: fullIdentity });

    sendJanus({
      janus: "message",
      transaction: makeTxId("join-pub"),
      session_id: sessionId,
      handle_id: pluginHandlePub,
      body: { request: "join", ptype: "publisher", room, display: fullIdentity },
    });

  } catch (e) {
    console.error("joinAsPublisher error:", e);
    Output.error("joinAsPublisher error", String(e));
  }
}

async function startPublishing() {
  try {
    const room = Number(els.roomId.value);

    // Se arriviamo qui, SIAMO SICURI di avere il master_secret
    const selfIndex = mlsInfo.sender_index;
    const txKey = await deriveTxKey(mlsInfo.master_secret, selfIndex);

    const kidAudio = computeKid(mlsInfo.epoch, room, selfIndex);
    const kidVideo = kidAudio + 1;

    txPeerRef = { peer: createTxPeer(kidAudio, kidVideo, txKey) };

    pcPub = new RTCPeerConnection({ iceServers: [] });

    pcPub.onicecandidate = ev => {
      if (!ev.candidate) {
        sendJanus({
          janus: "trickle",
          transaction: makeTxId("trickle-end-pub"),
          session_id: sessionId,
          handle_id: pluginHandlePub,
          candidate: { completed: true },
        });
        return;
      }
      sendJanus({
        janus: "trickle",
        transaction: makeTxId("trickle-pub"),
        session_id: sessionId,
        handle_id: pluginHandlePub,
        candidate: ev.candidate,
      });
    };

    // 🔴 AGGIORNATO: Qualità Video HD (720p a 30fps) per stressare SFrame
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 30 },
      },
    });

    els.localVideo.srcObject = localStream;

    const aTrack = localStream.getAudioTracks()[0];
    if (aTrack) {
      const s = pcPub.addTrack(aTrack, localStream);
      attachSenderTransform(s, "audio", txPeerRef);
    }

    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) {
      const s = pcPub.addTrack(vTrack, localStream);
      attachSenderTransform(s, "video", txPeerRef);
    }

    const offer = await pcPub.createOffer();
    await pcPub.setLocalDescription(offer);

    sendJanus({
      janus: "message",
      transaction: makeTxId("publish"),
      session_id: sessionId,
      handle_id: pluginHandlePub,
      body: {
        request: "publish",
        audio: true,
        video: true,
        bitrate: 2000000, // 🔴 AGGIORNATO: Aumentato a 2 Mbps per supportare l'HD
      },
      jsep: offer,
    });

  } catch (e) {
    console.error("REAL startPublishing error:", e);
    Output.error("startPublishing error", String(e), e.stack);
  }
}

// ─────────────────────────────────────────────────────────────
// Sender Transform (TX) + SFrame header log
// ─────────────────────────────────────────────────────────────

function attachSenderTransform(sender, kind, txPeerRefLocal) {
  if (!sender.createEncodedStreams) return;

  const { readable, writable } = sender.createEncodedStreams();
  
  // 🔴 INIZIO BENCHMARK: Variabili per calcolare la media
  let frameCount = 0;
  let totalCryptoTime = 0;
  let totalPipelineTime = 0;
  let totalBytes = 0; // 🔴 AGGIORNATO: Contatore Byte

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        if (!txPeerRefLocal || !txPeerRefLocal.peer) {
          controller.enqueue(chunk);
          return;
        }

        const tPipelineStart = performance.now();

        const u8 = new Uint8Array(chunk.data);
        const frameSize = u8.length; // 🔴 Salviamo la dimensione
        
        const t0 = performance.now();

        const out =
          kind === "audio"
            ? txPeerRefLocal.peer.encrypt_audio(u8)
            : txPeerRefLocal.peer.encrypt_video(u8);
            
        const t1 = performance.now();

        chunk.data = out.buffer;
        
        if (isSFrameLogEnabled()) {
          try {
            const h = sframe_last_tx_header();
            if (h && h.kid !== undefined) {
              Output.sframeHeader("TX", kind, h);
            }
          } catch (e) {}
        }

        controller.enqueue(chunk);
        
        const tPipelineEnd = performance.now();

        if (kind === "video") {
            frameCount++;
            totalCryptoTime += (t1 - t0);
            totalPipelineTime += (tPipelineEnd - tPipelineStart);
            totalBytes += frameSize; // Sommiamo i byte
            
            // Stampa la media ogni 150 frame (circa ogni 5 secondi)
            if (frameCount % 150 === 0) {
                const avgCrypto = (totalCryptoTime / 150).toFixed(3);
                const avgPipeline = (totalPipelineTime / 150).toFixed(3);
                const avgKb = (totalBytes / 150 / 1024).toFixed(2); // Media in KB
                
                console.log(`📊 [SFrame TX] Matematica: ${avgCrypto}ms | Pipeline: ${avgPipeline}ms | Peso Medio Frame: ${avgKb} KB`);
                
                totalCryptoTime = 0;
                totalPipelineTime = 0;
                totalBytes = 0;
            }
        }
      } catch (e) {
        Output.error("TX encrypt", e);
        controller.enqueue(chunk);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable);
}

// ─────────────────────────────────────────────────────────────
// Subscriber
// ─────────────────────────────────────────────────────────────

function subscribeToPublisher(feedId, display) {
  if (subscribers.has(feedId)) return;

  subscribers.set(feedId, {
    feedId,
    display,   // es. "nome#senderIndex"
    pc: null,
    handleId: null,
    rxPeerRef: null,
    videoEl: null,
    receivers: [], // lista RTCRtpReceiver
  });

  sendJanus({
    janus: "attach",
    plugin: "janus.plugin.videoroom",
    transaction: `attach-sub-${feedId}`,
    session_id: sessionId,
  });
}

function joinAsSubscriber(feedId, handleId) {
  const room = Number(els.roomId.value) || 0;

  sendJanus({
    janus: "message",
    transaction: makeTxId(`join-sub-${feedId}`),
    session_id: sessionId,
    handle_id: handleId,
    body: {
      request: "join",
      ptype: "subscriber",
      room,
      feed: feedId,
    },
  });
}

async function handleSubscriberJsep(feedId, sub, jsep) {
  try {
    const room = Number(els.roomId.value);

    if (!Number.isFinite(room) || room <= 0) {
      Output.error("No valid roomId for subscriber");
      return;
    }

    if (!sub.pc) {
      const pc = new RTCPeerConnection({ iceServers: [] });

      pc.onicecandidate = ev => {
        if (!ev.candidate) {
          sendJanus({
            janus: "trickle",
            transaction: makeTxId(`trickle-end-sub-${feedId}`),
            session_id: sessionId,
            handle_id: sub.handleId,
            candidate: { completed: true },
          });
          return;
        }
        sendJanus({
          janus: "trickle",
          transaction: makeTxId(`trickle-sub-${feedId}`),
          session_id: sessionId,
          handle_id: sub.handleId,
          candidate: ev.candidate,
        });
      };

      pc.ontrack = ev => {
        if (!sub.videoEl) {
          const box = document.createElement("div");
          box.className = "remoteBox";

          const label = document.createElement("label");
          label.textContent = `Feed ${feedId} (${sub.display})`;

          const vid = document.createElement("video");
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

        const receiver = ev.receiver;
        sub.receivers.push(receiver);

        if (receiver._sframeAttached) return; 
        receiver._sframeAttached = true;

        attachReceiverTransform(receiver, receiver.track.kind, sub);
      };

      sub.pc = pc;
    }

    await sub.pc.setRemoteDescription(new RTCSessionDescription(jsep));

    // ───── MLS + SFrame RX per questo sender remoto ─────
    if (!mlsInfo || !mlsInfo.master_secret) {
      Output.error("MLS not fully initialized for subscriber", {});
      return;
    }

    const { identity: remoteName, senderIndex: remoteIndex } =
      parseIdentityWithIndex(sub.display);

    if (remoteIndex == null) {
      Output.error("MLS: sender_index missing in remote display", {
        display: sub.display,
        remoteName,
      });
      return;
    }

    const rxKey = await deriveRxKey(mlsInfo.master_secret, remoteIndex);
    const kidAudio = computeKid(mlsInfo.epoch, room, remoteIndex);
    const kidVideo = kidAudio + 1;

    sub.rxPeerRef = { peer: createRxPeer(99, 98, kidAudio, kidVideo, rxKey) };

    const answer = await sub.pc.createAnswer();
    await sub.pc.setLocalDescription(answer);

    sendJanus({
      janus: "message",
      transaction: makeTxId(`start-sub-${feedId}`),
      session_id: sessionId,
      handle_id: sub.handleId,
      body: { request: "start", room: room },
      jsep: answer,
    });

    // 🔴 INIZIO FIX PROBLEMA 1: Richiesta Keyframe forzata multipla
    const askForKeyframe = () => {
        if (sub.handleId && sessionId) {
            sendJanus({
                janus: "message",
                transaction: makeTxId(`force-kf-initial-${feedId}`),
                session_id: sessionId,
                handle_id: sub.handleId,
                body: { request: "configure", keyframe: true }
            });
        }
    };

    // Scaglioniamo le richieste per coprire l'asincronia del player WebRTC
    setTimeout(askForKeyframe, 500);
    setTimeout(askForKeyframe, 1500);
    setTimeout(askForKeyframe, 3000);
    // 🔴 FINE FIX

  } catch (e) {
    Output.error("handleSubscriberJsep", e);
  }
}

// ─────────────────────────────────────────────────────────────
// Receiver Transform (RX) + SFrame header log
// ─────────────────────────────────────────────────────────────

function attachReceiverTransform(receiver, kind, sub) {
  if (!receiver.createEncodedStreams) return;

  const { readable, writable } = receiver.createEncodedStreams();
  
  let frameCount = 0;
  let totalCryptoTime = 0;
  let totalPipelineTime = 0;
  let totalBytes = 0; // 🔴 AGGIORNATO

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        if (keySyncInProgress) return;
        if (!sub.rxPeerRef || !sub.rxPeerRef.peer) return;

        const tPipelineStart = performance.now();

        const u8 = new Uint8Array(chunk.data);
        const frameSize = u8.length;
        let outU8;

        try {
          const t0 = performance.now();
          
          outU8 =
            kind === "audio"
              ? sub.rxPeerRef.peer.decrypt_audio(u8)
              : sub.rxPeerRef.peer.decrypt_video(u8);
              
          const t1 = performance.now();
          
          chunk.data = outU8.buffer;
          
          if (isSFrameLogEnabled()) {
            try {
              const h = sframe_last_rx_header();
              if (h && h.kid !== undefined) {
                Output.sframeHeader("RX", kind, h);
              }
            } catch (e) {}
          }

          controller.enqueue(chunk);

          const tPipelineEnd = performance.now();

          if (kind === "video") {
              frameCount++;
              totalCryptoTime += (t1 - t0);
              totalPipelineTime += (tPipelineEnd - tPipelineStart);
              totalBytes += frameSize;
              
              if (frameCount % 150 === 0) {
                  const avgCrypto = (totalCryptoTime / 150).toFixed(3);
                  const avgPipeline = (totalPipelineTime / 150).toFixed(3);
                  const avgKb = (totalBytes / 150 / 1024).toFixed(2);
                  
                  console.log(`📊 [SFrame RX] Matematica: ${avgCrypto}ms | Pipeline: ${avgPipeline}ms | Peso Medio Frame: ${avgKb} KB`);
                  
                  totalCryptoTime = 0;
                  totalPipelineTime = 0;
                  totalBytes = 0;
              }
          }

        } catch (e) {
          const errMsg = e.toString();
          if (errMsg.includes("DecryptionKey") || (e.message && e.message.includes("DecryptionKey"))) {
              return;
          }
          const now = Date.now();
          if (now - lastRxDecryptErrorTs > 1000) {
            lastRxDecryptErrorTs = now;
            Output.error("RX decrypt", e);
          }
          return;
        }
      } catch (e) {
        return;
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable);
}

// ─────────────────────────────────────────────────────────────
// Cleanup & subscriber removal
// ─────────────────────────────────────────────────────────────

function removeSubscriber(feedId) {
  const sub = subscribers.get(feedId);
  if (!sub) return;

  try {
    if (sub.pc) sub.pc.close();
  } catch {}

  if (sub.videoEl && sub.videoEl.parentNode) {
    sub.videoEl.parentNode.remove();
  }

  subscribers.delete(feedId);
}

function connectAndJoinRoom() {
  const url = els.wsUrl.value || "wss://sframe.local/janus";
  const room = Number(els.roomId.value);

  if (!Number.isFinite(room) || room <= 0) {
    Output.error("No room in URL, cannot join");
    return;
  }

  if (!isSFrameSupported()) {
    Output.error(
      "Questo browser non supporta WebRTC Insertable Streams / SFrame. Connessione bloccata."
    );
    alert(
      "Questo browser non supporta le API necessarie per la cifratura SFrame.\n" +
      "Prova con Chrome/Brave/Edge o Firefox (desktop) aggiornati."
    );
    return;
  }

  ws = new WebSocket(url, "janus-protocol");

  ws.onopen = () => {
    sendJanus({
      janus: "create",
      transaction: makeTxId("create"),
    });
  };

  ws.onmessage = onJanusMessage;
  ws.onclose = cleanup;
  ws.onerror = e => Output.error("WS error", e);

  setConnectedUI(true);
}

function hangup() {
  try {
    if (pluginHandlePub) {
      sendJanus({
        janus: "message",
        transaction: makeTxId("leave"),
        session_id: sessionId,
        handle_id: pluginHandlePub,
        body: { request: "leave" },
      });
    }
  } catch {}

  if (ws) ws.close();
  cleanup();
}

function cleanup() {
  stopKeepalive();
  stopMlsHeartbeat(); // 🔴 Fermiamo il polling MLS!

  if (pcPub) try { pcPub.close(); } catch {}
  pcPub = null;

  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  els.localVideo.srcObject = null;

  subscribers.forEach(sub => {
    if (sub.pc) try { sub.pc.close(); } catch {}
  });
  subscribers.clear();
  els.remoteVideos.innerHTML = "";

  const box = document.getElementById("remotePeers");
  if (box) box.innerHTML = "";

  sessionId = null;
  pluginHandlePub = null;
  mlsInfo = null;
  myIdentity = null;
  txPeerRef = null;
  lastRxDecryptErrorTs = 0;
  keySyncInProgress = false;
  setKeySyncInProgress(false);

  setConnectedUI(false);
}

// ─────────────────────────────────────────────────────────────
// Mic / Cam
// ─────────────────────────────────────────────────────────────

function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  els.btnToggleMic.textContent = t.enabled ? "Mic OFF" : "Mic ON";
}

function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  els.btnToggleCam.textContent = t.enabled ? "Cam OFF" : "Cam ON";
}

// ─────────────────────────────────────────────────────────────
// Bind UI + init
// ─────────────────────────────────────────────────────────────

els.btnConnect.addEventListener("click", connectAndJoinRoom);
els.btnHangup.addEventListener("click", hangup);
els.btnToggleMic.addEventListener("click", toggleMic);
els.btnToggleCam.addEventListener("click", toggleCam);

setupRoomOnLoad().catch(e => Output.error("Room setup failed", e));
Output.ui("App pronta", {});
// 🔴 MISURAZIONE LATENZA DI RETE (RTT verso Janus)
setInterval(async () => {
    if (!pcPub) return;
    try {
        const stats = await pcPub.getStats();
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                const rttMs = (report.currentRoundTripTime * 1000).toFixed(2);
                console.log(`🌐 [RETE WebRTC] Latenza verso il server Janus (RTT): ${rttMs} ms`);
            }
        });
    } catch(e) {}
}, 10000); // Stampa ogni 10 secondi