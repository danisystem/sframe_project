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

let mlsInfo = null;  // {sender_index, epoch, master_secret, roster}

const subscribers = new Map(); // feedId → {feedId, display, pc, rxPeer, videoEl}


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

function joinAsPublisher() {
  const room = Number(els.roomId.value) || 1234;
  const identity = els.displayName.value.trim() || ("user-" + crypto.randomUUID());

  Output.ui("Join as publisher", { room, identity });

  sendJanus({
    janus: "message",
    transaction: makeTxId("join-pub"),
    session_id: sessionId,
    handle_id: pluginHandlePub,
    body: {
      request: "join",
      ptype: "publisher",
      room,
      display: identity,
    },
  });
}

async function startPublishing() {
  try {
    // MLS join
    const identity = els.displayName.value.trim();
    mlsInfo = await mlsJoin(identity);
    Output.mls("MLS JOIN OK", mlsInfo);

    // Init SFrame
    await initSFrame();

    // TX KEY derivata via MLS
const txKey = await deriveTxKey(mlsInfo.master_secret, mlsInfo.sender_index);

    const kidAudio = computeKid(mlsInfo.epoch, mlsInfo.sender_index);
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
    display,
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

    // MLS – trova remote sender_index
    const remoteName = (sub.display || "").trim().toLowerCase();
    const entry = mlsInfo.roster.find(
      r => (r.identity || "").toLowerCase() === remoteName
    );

    if (!entry) {
      Output.error("MLS roster: sender_index not found", {
        remoteName,
        roster: mlsInfo.roster,
      });
      return;
    }

    const remoteIndex = entry.index;

    // Deriva RX key + KID
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
// Cleanup
// ─────────────────────────────────────────────────────────────

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
