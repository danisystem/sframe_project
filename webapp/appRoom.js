// appRoom.js
// ─────────────────────────────────────────────────────────────
// Janus VideoRoom + SFrame + MLS – multi-room con invite link
// ─────────────────────────────────────────────────────────────

// Carica WASM SFrame (espone window.SFRAME.WasmPeer, ecc.)
import "./bootstrap_sframe.js";

// Moduli UI / log
import { els, setConnectedUI } from "./ui.js";
import { Output } from "./output.js";

// MLS → segreti + mapping index/identity + KID
import {
  mlsJoin,
  mlsFetchRoster,
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

// feedId → {feedId, display, pc, rxPeer, videoEl, handleId}
const subscribers = new Map();

// ─────────────────────────────────────────────────────────────
// Utilità generali
// ─────────────────────────────────────────────────────────────
function isProbablySFramePacket(u8) {
  // 1) SFrame non può essere così corto
  if (u8.length < 20) return false;

  // 2) Il primo byte di header deve avere MSB = 1
  if ((u8[0] & 0x80) === 0) return false;

  return true;
}

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

  // 2) Nessuna room nell'URL → chiedo al backend di crearne una (Step A)
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

  // Eventi per il nostro Publisher
  if (sender === pluginHandlePub) {

    if (vr === "joined") {
      Output.janus("Joined as publisher", data.id);

      // publisher già presenti
      if (Array.isArray(data.publishers)) {
        data.publishers.forEach(p => subscribeToPublisher(p.id, p.display));
      }

      // roster iniziale (dal punto di vista di chi entra ora)
      refreshRosterUI().catch(() => {});

      startPublishing();
    }

    if (vr === "event" && Array.isArray(data.publishers)) {
      // nuovi publisher che entrano
      data.publishers.forEach(p => subscribeToPublisher(p.id, p.display));
      // aggiorna roster ovunque
      refreshRosterUI().catch(() => {});
    }

    if (data.unpublished) removeSubscriber(data.unpublished);

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

  // Identity base per questo peer (senza #index MLS)
  myIdentity =
    els.displayName.value.trim() || ("user-" + crypto.randomUUID());

  try {
    // 1) MLS JOIN (se non già fatto)
    if (!mlsInfo) {
      mlsInfo = await mlsJoin(myIdentity, room);
      Output.mls("MLS JOIN OK", mlsInfo);

      // aggiorna subito la lista “Remote peers”
      renderRemotePeers(mlsInfo.roster, myIdentity);
    }

    // 2) Identity per Janus = "nome#sender_index"
    const fullIdentity = attachIndexToIdentity(
      myIdentity,
      mlsInfo.sender_index
    );

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
        display: fullIdentity,
      },
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

    // safety: se per qualche motivo mlsInfo non c'è, rifacciamo join
    if (!mlsInfo) {
      myIdentity =
        els.displayName.value.trim() || ("user-" + crypto.randomUUID());
      mlsInfo = await mlsJoin(myIdentity, room);
      Output.mls("MLS JOIN (late) OK", mlsInfo);
      renderRemotePeers(mlsInfo.roster, myIdentity);
    }

    // Init SFrame WASM
    await initSFrame();

    // TX key derivata via MLS (singola chiave per audio+video)
    const selfIndex = mlsInfo.sender_index;
    const txKey = await deriveTxKey(mlsInfo.master_secret, selfIndex);

    // KID TX (audio/video) per questo peer – dipendono da (epoch, room, sender)
    const kidAudio = computeKid(mlsInfo.epoch, room, selfIndex);
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

    // Media locale
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true },
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 20, max: 25 },
      },
    });

    els.localVideo.srcObject = localStream;

    // Aggiungi tracce + trasformazioni SFrame TX
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
// Helper: ispezione header SFrame per logging
// ─────────────────────────────────────────────────────────────

function inspectSframePacket(direction, kind, buf) {
  // buf è un Uint8Array con il pacchetto SFrame cifrato
  if (!buf || buf.length < 3) return;

  // Byte 0: versione + info lunghezze (per i nostri parametri è sufficiente)
  const h0 = buf[0];

  // Nei nostri test:
  //  - key-id è sempre su 1 byte
  //  - la lunghezza del contatore è codificata negli ultimi 2 bit di h0
  const kid_len_bytes = 1;
  const ctr_len_bytes = (h0 & 0x03) + 1; // 0 -> 1 byte, 1 -> 2 byte, ...

  const header_len = 1 + kid_len_bytes + ctr_len_bytes;

  if (buf.length < header_len) return;

  const kid = buf[1];

  let ctr = 0;
  for (let i = 0; i < ctr_len_bytes; i++) {
    ctr = (ctr << 8) | buf[2 + i];
  }

  const total_len = buf.length;
  const tag_len = total_len > header_len ? 16 : 0; // usiamo sempre GCM → 16B
  const body = total_len - header_len;
  const ct_len = body >= tag_len ? (body - tag_len) : body;
  const aad_len = header_len;

  const header_hex = Array.from(buf.slice(0, header_len))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  Output.sframeHeader(direction, kind, {
    kid,
    kid_len_bytes,
    ctr,
    ctr_len_bytes,
    aad_len,
    ct_len,
    tag_len,
    total_len,
    header_hex,
  });
}


// ─────────────────────────────────────────────────────────────
// Sender Transform (TX)
// ─────────────────────────────────────────────────────────────

function attachSenderTransform(sender, kind, txPeer) {
  if (!sender.createEncodedStreams) return;

  const { readable, writable } = sender.createEncodedStreams();

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        const u8 = new Uint8Array(chunk.data);

        const out =
          kind === "audio"
            ? txPeer.encrypt_audio(u8)
            : txPeer.encrypt_video(u8);

        // 🔍 Log header SFrame sul pacchetto cifrato (se il log è ON)
        inspectSframePacket("TX", kind, out);

        chunk.data = out.buffer;
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
  // Se abbiamo già questo feedId, non fare nulla
  if (subscribers.has(feedId)) return;

  // 🔁 Deduplica per identity: se esiste già un subscriber
  // con lo stesso display (es. "dani#1"), lo rimuoviamo.
  for (const [fid, sub] of subscribers.entries()) {
    if (sub.display === display && fid !== feedId) {
      removeSubscriber(fid);
    }
  }

  subscribers.set(feedId, {
    feedId,
    display,   // es. "nome#senderIndex"
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

    sub.rxPeer = createRxPeer(99, 98, kidAudio, kidVideo, rxKey);

    // Attacca trasformazioni RX
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
      body: { request: "start", room: room },
      jsep: answer,
    });

  } catch (e) {
    Output.error("handleSubscriberJsep", e);
  }
}

// ─────────────────────────────────────────────────────────────
// Receiver Transform (RX)
// ─────────────────────────────────────────────────────────────

function attachReceiverTransform(receiver, kind, sub) {
  if (!receiver.createEncodedStreams) return;

  const { readable, writable } = receiver.createEncodedStreams();

  const transform = new TransformStream({
    async transform(chunk, controller) {
      try {
        const u8 = new Uint8Array(chunk.data);

        // 🔥  FIX: se non sembra un pacchetto SFrame, NON proviamo a decriptarlo
        if (!isProbablySFramePacket(u8)) {
          controller.enqueue(chunk); 
          return;
        }

        // 🔥 Decriptiamo solo i pacchetti veri SFrame
        const out =
          kind === "audio"
            ? sub.rxPeer.decrypt_audio(u8)
            : sub.rxPeer.decrypt_video(u8);

        chunk.data = out.buffer;
        controller.enqueue(chunk);

      } catch (e) {
        // se la decrypt fallisce, NON blocchiamo lo stream
        Output.error("RX decrypt", e);
        controller.enqueue(chunk);
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
