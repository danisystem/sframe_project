console.log("[BOOT] appv2.js loaded");
document.getElementById("boot").textContent = "BOOT OK: appv2.js caricato";

import init, { WasmPeer, sframe_inspect } from "./pkg/sframe_core.js";

const ENABLE_ENCRYPT = true;
const ENABLE_DECRYPT = true;
const INSPECT_EVERY = 25;

const $ = (s) => document.querySelector(s);
const dbg = $("#debug");
const log = (...a) => { console.log("[app]", ...a); dbg.textContent += "\n" + a.join(" "); };
const err = (...a) => { console.error("[app]", ...a); dbg.textContent += "\nERR " + a.join(" "); };

const supportsSender = (s) => typeof s?.createEncodedStreams === "function";
const supportsReceiver = (r) => typeof r?.createEncodedStreams === "function";

window.addEventListener("DOMContentLoaded", async () => {
  const startBtn = $("#start");
  const unmuteBtn = $("#unmute");
  const local = $("#local");
  const remote = $("#remote");

  await init();
  log("WASM init OK");

  startBtn.onclick = async () => {
    startBtn.disabled = true;

    const wsUrl  = $("#wsurl").value.trim();
    const room   = $("#room").value.trim();
    const secret = $("#secret").value.trim();
    const suite  = $("#suite").value || null;

    // Config manuale dei KeyId per peer A o B
    const peerName = prompt("Identifica peer (A o B):", "A").toUpperCase();
    const keyMap = peerName === "A" ? {
      tx: { audio: 101, video: 102 },
      rx: { audio: 201, video: 202 }
    } : {
      tx: { audio: 201, video: 202 },
      rx: { audio: 101, video: 102 }
    };

    log(`Avvio ${peerName}  TX[a=${keyMap.tx.audio},v=${keyMap.tx.video}]  RX[a=${keyMap.rx.audio},v=${keyMap.rx.video}]`);

    const enc = new TextEncoder().encode(secret);
    let peerTX, peerRX;
    try {
      peerTX = new WasmPeer(keyMap.tx.audio, keyMap.tx.video, suite, enc);
      peerRX = new WasmPeer(keyMap.rx.audio, keyMap.rx.video, suite, enc);
    } catch (e) {
      err("Init peers", e);
      return;
    }

    // WebRTC
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

    // Signaling
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => ws.send(JSON.stringify({ room, type: "join" }));
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "offer" && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(msg.data);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        ws.send(JSON.stringify({ room, type: "answer", data: pc.localDescription }));
      } else if (msg.type === "answer" && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(msg.data);
      } else if (msg.type === "candidate") {
        try { await pc.addIceCandidate(msg.data); } catch (e) { err("addIceCandidate", e); }
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ room, type: "candidate", data: e.candidate }));
    };

    // RX decrypt
    pc.ontrack = (ev) => {
      remote.srcObject = ev.streams[0];
      remote.play().catch(()=>{});
      const rx = pc.getReceivers().find(r => r.track === ev.track);
      const peer = ev.track.kind === "video" ? peerRX : peerRX;
      if (ENABLE_DECRYPT && supportsReceiver(rx)) {
        const { readable, writable } = rx.createEncodedStreams();
        const ts = new TransformStream({
          transform(encoded, ctrl) {
            try {
              const data = new Uint8Array(encoded.data);
              const out = ev.track.kind === "video"
                ? peer.decrypt_video(data)
                : peer.decrypt_audio(data);
              encoded.data = out.buffer;
              ctrl.enqueue(encoded);
            } catch (e) {
              err("RX decrypt", e);
              ctrl.enqueue(encoded);
            }
          }
        });
        readable.pipeThrough(ts).pipeTo(writable).catch(()=>{});
      }
    };

    // TX encrypt
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    local.srcObject = stream;
    local.muted = true;
    await local.play();

    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream);
      const peer = track.kind === "video" ? peerTX : peerTX;
      if (ENABLE_ENCRYPT && supportsSender(sender)) {
        const { readable, writable } = sender.createEncodedStreams();
        const ts = new TransformStream({
          transform(encoded, ctrl) {
            try {
              const data = new Uint8Array(encoded.data);
              const out = track.kind === "video"
                ? peer.encrypt_video(data)
                : peer.encrypt_audio(data);
              encoded.data = out.buffer;
              ctrl.enqueue(encoded);
            } catch (e) {
              err("TX encrypt", e);
              ctrl.enqueue(encoded);
            }
          }
        });
        readable.pipeThrough(ts).pipeTo(writable).catch(()=>{});
      }
    }

    // SDP exchange
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ room, type: "offer", data: pc.localDescription }));
    log("Offer sent");
  };

  unmuteBtn.onclick = async () => {
    remote.muted = false;
    await remote.play();
    log("remote unmuted");
  };
});
