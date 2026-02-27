// appRoom.js
// ─────────────────────────────────────────────────────────────
// Janus VideoRoom + SFrame + MLS – multi-room con invite link
// ─────────────────────────────────────────────────────────────

// Moduli UI / log
import { els, setConnectedUI, isSFrameLogEnabled } from "./ui.js";
import { Output } from "./output.js";

// MLS → segreti + mapping index/identity + KID
import {
  mlsJoin,
  mlsFetchRoster,
  mlsResync, // ← resync epoch / master_secret
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

// 🔹 FUNZIONI WASM PER GLI HEADER SFRAME (già presenti in lib.rs)
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
let localStream = null;

// Info MLS per questo peer:
// { sender_index, epoch, group_id, room_id, master_secret, roster }
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

// Resync MLS: controlla se l'epoch è cambiata e, se sì, rekey SFrame
async function maybeResyncMls(reason) {
  if (!mlsInfo || !myIdentity) return;

  const room = Number(els.roomId.value);
  if (!Number.isFinite(room) || room <= 0) return;

  setKeySyncInProgress(true, reason);

  try {
    const { changed, info } = await mlsResync(myIdentity, room, mlsInfo);
    if (!changed) {
      Output.mls("MLS epoch unchanged", { reason, epoch: mlsInfo.epoch });
      return;
    }

    Output.mls("MLS epoch CHANGED", {
      reason,
      oldEpoch: mlsInfo.epoch,
      newEpoch: info.epoch,
    });

    mlsInfo = info;
    await rekeyAllPeers();
  } catch (e) {
    Output.error("MLS resync failed", { reason, error: e });
  } finally {
    setKeySyncInProgress(false, reason);
  }
}

// Rigenera chiavi/KID e aggiorna i peer SFrame TX/RX
async function rekeyAllPeers() {
  if (!mlsInfo) return;

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

      Output.sframe("TX peer rekeyed", {
        epoch: mlsInfo.epoch, selfIndex, kidAudio, kidVideo,
      });
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
      const kidAudio = computeKid(mlsInfo.epoch, room, remoteIndex);
      const kidVideo = kidAudio + 1;

      sub.rxPeerRef = sub.rxPeerRef || {};
      sub.rxPeerRef.peer = createRxPeer(99, 98, kidAudio, kidVideo, rxKey);

      Output.sframe("RX peer rekeyed", {
        feedId, remoteIndex, epoch: mlsInfo.epoch, kidAudio, kidVideo,
      });

      // 🔴 FIX: Richiedi un Keyframe a Janus per sbloccare subito il video!
      if (sub.handleId && sessionId) {
        sendJanus({
          janus: "message",
          transaction: makeTxId(`force-kf-${feedId}`),
          session_id: sessionId,
          handle_id: sub.handleId,
          body: { request: "configure", keyframe: true }
        });
      }

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

  // 1) C'è già ?room=... → uso quello
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

  // 2) Nessuna room nell'URL → chiedo al backend di crearne una
  Output.ui("No room in URL -> creating new room...", {});
  try {
    const res = await fetch("/api/new-room", { method: "POST" });
    const json = await res.json();

    if (!res.ok || !json.roomId) {
      throw new Error("Bad response from /api/new-room");
    }

    const room = Number(json.roomId);

    // Aggiorno URL nel browser con ?room=...
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
      startPublishing().catch(e => {
        Output.error("startPublishing error (joined)", e);
      });
      requestParticipantsList();
      return;
    }

    if (vr === "event") {
      if (Array.isArray(data.publishers)) {
        // 🔴 FIX: Prima sincronizziamo MLS, poi ci iscriviamo al video!
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
    // 🔴 FIX: Carica WASM subito all'inizio della connessione!
    await initSFrame(); 

    if (!mlsInfo) {
      mlsInfo = await mlsJoin(myIdentity, room);
      Output.mls("MLS JOIN OK", mlsInfo);
      renderRemotePeers(mlsInfo.roster, myIdentity);
    }

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

    if (!Number.isFinite(room) || room <= 0) {
      Output.error("No valid roomId for publishing");
      return;
    }

    if (!mlsInfo) {
      myIdentity =
        els.displayName.value.trim() || ("user-" + crypto.randomUUID());
      mlsInfo = await mlsJoin(myIdentity, room);
      Output.mls("MLS JOIN (late) OK", mlsInfo);
      renderRemotePeers(mlsInfo.roster, myIdentity);
    }

    await initSFrame();

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

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 20, max: 25 },
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
        bitrate: 800000,
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

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        if (!txPeerRefLocal || !txPeerRefLocal.peer) {
          controller.enqueue(chunk);
          return;
        }

        const u8 = new Uint8Array(chunk.data);
        const out =
          kind === "audio"
            ? txPeerRefLocal.peer.encrypt_audio(u8)
            : txPeerRefLocal.peer.encrypt_video(u8);
        chunk.data = out.buffer;

        if (isSFrameLogEnabled()) {
          try {
            const h = sframe_last_tx_header();
            if (h && h.kid !== undefined) {
              Output.sframeHeader("TX", kind, {
                kid: h.kid,
                kid_len_bytes: 0,
                ctr: h.ctr,
                ctr_len_bytes: 0,
                aad_len: h.header_len,
                ct_len: h.ct_len,
                tag_len: h.tag_len,
                total_len: h.total_len,
                header_hex: h.header_hex,
              });
            }
          } catch (e) {
            Output.error("SFrame TX header log failed", e);
          }
        }

        controller.enqueue(chunk);
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
        // UI video
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

        // SFrame RX: attacchiamo le trasformazioni APPENA arriva la traccia
        const receiver = ev.receiver;
        sub.receivers.push(receiver);

        if (receiver._sframeAttached) return; // evita doppi attach
        receiver._sframeAttached = true;

        attachReceiverTransform(receiver, receiver.track.kind, sub);
      };

      sub.pc = pc;
    }

    await sub.pc.setRemoteDescription(new RTCSessionDescription(jsep));

    // ───── MLS + SFrame RX per questo sender remoto ─────
    if (!mlsInfo) {
      Output.error("MLS not initialized for subscriber", {});
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

    // NB: le trasformazioni RX vengono attaccate in ontrack.
    // Qui ci assicuriamo solo che, se qualche receiver è già arrivato,
    // abbia la ref aggiornata a rxPeerRef.
    // (attachReceiverTransform userà sempre sub.rxPeerRef.peer.)

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

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        // Durante il key sync → droppiamo i frame
        if (keySyncInProgress) {
          return;
        }

        if (!sub.rxPeerRef || !sub.rxPeerRef.peer) {
          // chiavi non pronte → non mandiamo frame cifrati al decoder
          return;
        }

        const u8 = new Uint8Array(chunk.data);
        let outU8;

        try {
          outU8 =
            kind === "audio"
              ? sub.rxPeerRef.peer.decrypt_audio(u8)
              : sub.rxPeerRef.peer.decrypt_video(u8);
        } catch (e) {
          const now = Date.now();
          if (now - lastRxDecryptErrorTs > 1000) {
            lastRxDecryptErrorTs = now;
            Output.error("RX decrypt", e);
          }
          // frame cifrato non utilizzabile → non enqueue
          return;
        }

        chunk.data = outU8.buffer;

        if (isSFrameLogEnabled()) {
          try {
            const h = sframe_last_rx_header();
            if (h && h.kid !== undefined) {
              Output.sframeHeader("RX", kind, {
                kid: h.kid,
                kid_len_bytes: 0,
                ctr: h.ctr,
                ctr_len_bytes: 0,
                aad_len: h.header_len,
                ct_len: h.ct_len,
                tag_len: h.tag_len,
                total_len: h.total_len,
                header_hex: h.header_hex,
              });
            }
          } catch (e) {
            Output.error("SFrame RX header log failed", e);
          }
        }

        controller.enqueue(chunk);
      } catch (e) {
        const now = Date.now();
        if (now - lastRxDecryptErrorTs > 1000) {
          lastRxDecryptErrorTs = now;
          Output.error("RX decrypt outer", e);
        }
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