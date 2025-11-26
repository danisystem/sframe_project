// appRoom.js
// ─────────────────────────────────────────────────────────────
// Janus VideoRoom + SFrame + MLS – versione modulare finale
// ─────────────────────────────────────────────────────────────

// Carica WASM prima di tutto
import "./bootstrap_sframe.js";

// Moduli
import { els, setConnectedUI } from "./ui.js";
import { Output } from "./output.js";

import {
  mlsJoin,
  deriveTxKey,
  deriveRxKey,
  computeKid,
  attachIndexToIdentity,
  parseIdentityWithIndex,
} from "./mls_sframe_session.js";

import {
  initSFrame,
  createTxPeer,
  createRxPeer,
} from "./sframe_layer.js";


// Stato globale
let ws = null;
let sessionId = null;
let pluginHandlePub = null;
let pcPub = null;
let keepaliveTimer = null;
let localStream = null;

// Info MLS per questo peer:
// { sender_index, epoch, master_secret, roster }
let mlsInfo = null;

const subscribers = new Map(); // feedId → {feedId, display, pc, rxPeer, videoEl, handleId}


// ─────────────────────────────────────────────────────────────
// UTIL
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


// SUCCESS
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


// EVENT
function handleEvent(msg) {
  const { sender, plugindata, jsep } = msg;

  if (!plugindata || plugindata.plugin !== "janus.plugin.videoroom") return;
  const data = plugindata.data || {};
  const vr = data.videoroom;

  // Events for Publisher (our handle)
  if (sender === pluginHandlePub) {

    if (vr === "joined") {
      Output.janus("Joined as publisher", data.id);

      if (Array.isArray(data.publishers)) {
        data.publishers.forEach(p => subscribeToPublisher(p.id, p.display));
      }

      startPublishing();
    }

    if (vr === "event" && Array.isArray(data.publishers)) {
      data.publishers.forEach(p => subscribeToPublisher(p.id, p.display));
    }

    if (data.unpublished) removeSubscriber(data.unpublished);

    if (jsep) {
      pcPub.setRemoteDescription(new RTCSessionDescription(jsep));
    }

    return;
  }

  // Subscriber events
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

async function joinAsPublisher() {
  const room = Number(els.roomId.value) || 1234;
  const baseIdentity = els.displayName.value.trim() || ("user-" + crypto.randomUUID());

  try {
    // 1) MLS JOIN (se non già fatto)
    if (!mlsInfo) {
      mlsInfo = await mlsJoin(baseIdentity);
      Output.mls("MLS JOIN OK", mlsInfo);
    }

    // 2) Identity per Janus = "nome#sender_index"
    const fullIdentity = attachIndexToIdentity(baseIdentity, mlsInfo.sender_index);

    Output.ui("Join as publisher", { room, identity: fullIdentity });

    // 3) Join VideoRoom
    sendJanus({
      janus: "message",
      transaction: makeTxId("join-pub"),
      session_id: sessionId,
      handle_id: pluginHandlePub,
      body: {
        request: "join",
        ptype: "publisher",
        room,
        display: fullIdentity,  // molto importante
      },
    });

  } catch (e) {
    console.error("joinAsPublisher error:", e);
    Output.error("joinAsPublisher error", String(e));
  }
}

async function startPublishing() {
  try {
    // In caso di race (improbabile): garantiamo che mlsInfo ci sia
    if (!mlsInfo) {
      const baseIdentity = els.displayName.value.trim() || ("user-" + crypto.randomUUID());
      mlsInfo = await mlsJoin(baseIdentity);
      Output.mls("MLS JOIN (late) OK", mlsInfo);
    }

    // Init SFrame
    await initSFrame();

    // TX KEY derivata via MLS (per il nostro sender_index)
    const selfIndex = mlsInfo.sender_index;
    const txKey = await deriveTxKey(mlsInfo.master_secret, selfIndex);

    // KID TX (audio/video) per questo peer
    const kidAudio = computeKid(mlsInfo.epoch, selfIndex);
    const kidVideo = kidAudio + 1;

    const txPeer = createTxPeer(kidAudio, kidVideo, txKey);

    // WebRTC
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

    // Media
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 20, max: 25 }
      }
    });

    els.localVideo.srcObject = localStream;

    // Aggiungi tracce + trasformazioni
    const aTrack = localStream.getAudioTracks()[0];
    if (aTrack) {
      const s = pcPub.addTrack(aTrack, localStream);
      attachSenderTransform(s, "audio", txPeer);
    }

    const vTrack = localStream.getVideoTracks()[0];
    if (vTrack) {
      const s = pcPub.addTrack(vTrack, localStream);
      attachSenderTransform(s, "video", txPeer);
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
// Sender Transform (TX)
// ─────────────────────────────────────────────────────────────

function attachSenderTransform(sender, kind, txPeer) {
  if (!sender.createEncodedStreams) return;

  const { readable, writable } = sender.createEncodedStreams();

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        const u8 = new Uint8Array(chunk.data);
        const out =
          kind === "audio"
            ? txPeer.encrypt_audio(u8)
            : txPeer.encrypt_video(u8);
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        Output.error("TX encrypt", e);
        controller.enqueue(chunk);
      }
    }
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
    display,   // sarà tipo "nome#senderIndex"
    pc: null,
    handleId: null,
    rxPeer: null,
    videoEl: null,
  });

  sendJanus({
    janus: "attach",
    plugin: "janus.plugin.videoroom",
    transaction: `attach-sub-${feedId}`,
    session_id: sessionId,
  });
}

function joinAsSubscriber(feedId, handleId) {
  const room = Number(els.roomId.value) || 1234;

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
      };

      sub.pc = pc;
    }

    await sub.pc.setRemoteDescription(new RTCSessionDescription(jsep));

    // ───── MLS – derivazione RX in base a sender_index nel display ─────
    if (!mlsInfo) {
      Output.error("MLS not initialized for subscriber", {});
      return;
    }

    // sub.display è qualcosa tipo "nome#senderIndex"
    const { identity: remoteName, senderIndex: remoteIndex } =
      parseIdentityWithIndex(sub.display);

    if (remoteIndex == null) {
      Output.error("MLS: sender_index missing in remote display", {
        display: sub.display,
        remoteName,
      });
      return;
    }

    // Deriva RX key + KID per questo sender_index remoto
    const rxKey = await deriveRxKey(mlsInfo.master_secret, remoteIndex);
    const kidAudio = computeKid(mlsInfo.epoch, remoteIndex);
    const kidVideo = kidAudio + 1;

    sub.rxPeer = createRxPeer(99, 98, kidAudio, kidVideo, rxKey);

    // Attacca transform RX
    sub.pc.getReceivers().forEach(r => {
      if (r.track.kind === "audio") attachReceiverTransform(r, "audio", sub);
      if (r.track.kind === "video") attachReceiverTransform(r, "video", sub);
    });

    const answer = await sub.pc.createAnswer();
    await sub.pc.setLocalDescription(answer);

    sendJanus({
      janus: "message",
      transaction: makeTxId(`start-sub-${feedId}`),
      session_id: sessionId,
      handle_id: sub.handleId,
      body: { request: "start", room: Number(els.roomId.value) || 1234 },
      jsep: answer,
    });

  } catch (e) {
    Output.error("handleSubscriberJsep", e);
  }
}


// Receiver Transform
function attachReceiverTransform(receiver, kind, sub) {
  if (!receiver.createEncodedStreams) return;

  const { readable, writable } = receiver.createEncodedStreams();

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        const u8 = new Uint8Array(chunk.data);
        const out =
          kind === "audio"
            ? sub.rxPeer.decrypt_audio(u8)
            : sub.rxPeer.decrypt_video(u8);
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        Output.error("RX decrypt", e);
        controller.enqueue(chunk);
      }
    }
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
  const url = els.wsUrl.value || "ws://localhost:8188/";

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

  sessionId = null;
  pluginHandlePub = null;

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
// Bind UI
// ─────────────────────────────────────────────────────────────

els.btnConnect.addEventListener("click", connectAndJoinRoom);
els.btnHangup.addEventListener("click", hangup);
els.btnToggleMic.addEventListener("click", toggleMic);
els.btnToggleCam.addEventListener("click", toggleCam);

Output.ui("App pronta", {});
