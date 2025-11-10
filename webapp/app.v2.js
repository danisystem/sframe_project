// BOOT probe
console.log("[BOOT] app.v2.js loaded");
document.getElementById("boot").textContent = "BOOT OK: app.v2.js caricato";

// Import WASM (namespace import: tollerante se mancano alcuni export)
import init, * as wasm from "./pkg/sframe_core.js";

// Config
const ENABLE_ENCRYPT = true;
const ENABLE_DECRYPT = true;
const INSPECT_EVERY = 30;

// Helpers
const $ = (s) => document.querySelector(s);
const dbg = $("#debug");
const log = (...a) => { console.log("[app]", ...a); dbg.textContent += "\n" + a.join(" "); };
const warn = (...a) => { console.warn("[app]", ...a); dbg.textContent += "\nWARN " + a.join(" "); };
const err = (...a) => { console.error("[app]", ...a); dbg.textContent += "\nERR " + a.join(" "); };

function supportsEncodedStreamsSender(sender) { return typeof sender?.createEncodedStreams === "function"; }
function supportsEncodedStreamsReceiver(receiver){ return typeof receiver?.createEncodedStreams === "function"; }

// Contatori per ispezione
let txV = 0, txA = 0, rxV = 0, rxA = 0;

window.addEventListener("DOMContentLoaded", async () => {
  const startBtn = $("#start");
  const unmuteBtn = $("#unmute");
  const local = $("#local");
  const remote = $("#remote");

  startBtn.disabled = false;
  await init();
  log("WASM init OK (bi-dir)");

  startBtn.onclick = async () => {
    startBtn.disabled = true;

    const wsUrl  = $("#wsurl").value.trim();
    const room   = $("#room").value.trim();
    const secret = $("#secret").value;
    const suite  = $("#suite").value || null;
    const beCaller = $("#caller").checked;

    log(`Start bi-dir. room=${room} caller=${beCaller}`);

    // Istanzia WasmPeer (prova u32 → fallback BigInt)
    let peer;
    try {
      peer = new wasm.WasmPeer(1, 2, suite, new TextEncoder().encode(secret));
      log("WasmPeer u32");
    } catch {
      peer = new wasm.WasmPeer(1n, 2n, suite, new TextEncoder().encode(secret));
      log("WasmPeer u64(BigInt)");
    }

    // RTCPeerConnection
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicegatheringstatechange = () => log("iceGatheringState:", pc.iceGatheringState);
    pc.oniceconnectionstatechange = () => log("iceConnectionState:", pc.iceConnectionState);
    pc.onconnectionstatechange = () => log("connectionState:", pc.connectionState);
    pc.onsignalingstatechange = () => log("signalingState:", pc.signalingState);

    // Signaling WS (server in Node/Python che inoltra {room,type,data})
    const ws = new WebSocket(wsUrl);
    ws.onopen  = () => { log("WS open", wsUrl); ws.send(JSON.stringify({ room, type: "join" })); };
    ws.onerror = (e) => err("WS error", e);

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      log("WS <-", msg.type);
      if (msg.type === "offer") {
        await pc.setRemoteDescription(msg.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ room, type: "answer", data: pc.localDescription }));
        log("answer sent");
      } else if (msg.type === "answer") {
        await pc.setRemoteDescription(msg.data);
      } else if (msg.type === "candidate") {
        try { await pc.addIceCandidate(msg.data); } catch (e) { err("addIceCandidate", e); }
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ room, type: "candidate", data: e.candidate }));
      else log("ICE gathering complete");
    };

    // RX: attach e decrypt via createEncodedStreams
    pc.ontrack = (ev) => {
      log("ontrack", ev.track.kind);
      remote.srcObject = ev.streams[0];
      remote.muted = true; // autoplay policy
      remote.play().catch(()=>{});

      const rx = pc.getReceivers().find(r => r.track === ev.track);
      if (!rx) return;

      if (ENABLE_DECRYPT && supportsEncodedStreamsReceiver(rx)) {
        log("RX decrypt via createEncodedStreams()", rx.track.kind);
        const { readable, writable } = rx.createEncodedStreams();
        const ts = new TransformStream({
          transform: (encodedFrame, controller) => {
            try {
              const input = new Uint8Array(encodedFrame.data);

              // ispezione del pacchetto cifrato (in ingresso)
              try {
                if (typeof wasm.sframe_inspect === "function") {
                  if (ev.track.kind === "video") {
                    if ((rxV++ % INSPECT_EVERY) === 0) console.log("[SFrame][RX][VID]", wasm.sframe_inspect(input));
                  } else {
                    if ((rxA++ % INSPECT_EVERY) === 0) console.log("[SFrame][RX][AUD]", wasm.sframe_inspect(input));
                  }
                }
              } catch (_){}

              const out = (ev.track.kind === "video")
                ? peer.decrypt_video(input)
                : peer.decrypt_audio(input);

              encodedFrame.data = out.buffer;
              controller.enqueue(encodedFrame);
            } catch (e) {
              err("RX decrypt error:", e);
              controller.enqueue(encodedFrame); // fallback clear
            }
          }
        });
        readable.pipeThrough(ts).pipeTo(writable).catch(()=>{});
      } else {
        warn("RX in chiaro (no transform). support:", supportsEncodedStreamsReceiver(rx), "ENABLE_DECRYPT:", ENABLE_DECRYPT);
      }
    };

    // Cattura media locale (entrambi i peer)
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .catch((e)=>{ err("getUserMedia", e); throw e; });
    local.srcObject = stream;
    local.muted = true;
    await local.play().catch(()=>{});

    // Aggiungi tracce locali e applica encrypt via createEncodedStreams
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      if (ENABLE_ENCRYPT && supportsEncodedStreamsSender(sender)) {
        log("TX encrypt via createEncodedStreams()", track.kind);
        const { readable, writable } = sender.createEncodedStreams();
        const ts = new TransformStream({
          transform: (encodedFrame, controller) => {
            try {
              const input = new Uint8Array(encodedFrame.data);
              const out = (track.kind === "video")
                ? peer.encrypt_video(input)
                : peer.encrypt_audio(input);

              // ispezione del pacchetto cifrato (in uscita)
              try {
                if (typeof wasm.sframe_inspect === "function") {
                  if (track.kind === "video") {
                    if ((txV++ % INSPECT_EVERY) === 0) console.log("[SFrame][TX][VID]", wasm.sframe_inspect(out));
                  } else {
                    if ((txA++ % INSPECT_EVERY) === 0) console.log("[SFrame][TX][AUD]", wasm.sframe_inspect(out));
                  }
                }
              } catch (_){}

              encodedFrame.data = out.buffer;
              controller.enqueue(encodedFrame);
            } catch (e) {
              err("TX encrypt error:", e);
              controller.enqueue(encodedFrame);
            }
          }
        });
        readable.pipeThrough(ts).pipeTo(writable).catch(()=>{});
      } else {
        warn("TX in chiaro (no transform). support:", supportsEncodedStreamsSender(sender), "ENABLE_ENCRYPT:", ENABLE_ENCRYPT);
      }
    }

    // Se questo peer è il Caller → crea l'offer
    if (beCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ room, type: "offer", data: pc.localDescription }));
      log("offer sent");
    }

    // Unmute
    unmuteBtn.onclick = async () => {
      try { remote.muted = false; await remote.play(); log("remote unmuted"); } catch (e) { err("unmute error", e); }
    };
  };
});
