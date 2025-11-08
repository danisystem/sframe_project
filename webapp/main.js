import init, { WasmPeer } from "./pkg/sframe_core.js";

const local = document.getElementById("local");
const remote = document.getElementById("remote");
const btn = document.getElementById("start");
const info = document.getElementById("info") || (() => {})();

function hasScriptTransform() {
  return typeof window.RTCRtpScriptTransform === "function";
}

btn.onclick = async () => {
  btn.disabled = true;

  // Inizializza il modulo wasm
  await init();

  const secret = "SUPER_SECRET";
  const suite = null; // usa default aes-gcm256-sha512

  // ⚙️ Crea peer WASM (accetta u32 oppure BigInt, a seconda della tua build)
  let peer;
  try {
    peer = new WasmPeer(1, 2, suite, new TextEncoder().encode(secret));
  } catch (e) {
    peer = new WasmPeer(1n, 2n, suite, new TextEncoder().encode(secret));
  }

  // Crea connessioni WebRTC in loopback (pc1 ↔ pc2)
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();

  // ICE scambio locale
  pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);

  // Mostra lo stream remoto decifrato
  pc2.ontrack = ev => {
    remote.srcObject = ev.streams[0];
    remote.play().catch(() => {});
  };

  // Prendi la camera
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 } },
    audio: true
  });
  local.srcObject = stream;
  await local.play().catch(() => {});

  // Aggiungi tracce
  for (const track of stream.getTracks()) {
    const sender = pc1.addTrack(track, stream);

    // ✳️ CIFRATURA lato invio (Encrypt)
    if (hasScriptTransform()) {
      console.log("Applying encryption transform on", track.kind);
      // @ts-ignore
      sender.transform = new RTCRtpScriptTransform({
        transformer: {
          transform: (encodedFrame, controller) => {
            try {
              const input = new Uint8Array(encodedFrame.data);
              const out = track.kind === "video"
                ? peer.encrypt_video(input)
                : peer.encrypt_audio(input);
              encodedFrame.data = out.buffer;
              controller.enqueue(encodedFrame);
            } catch (e) {
              console.error("Encrypt transform error:", e);
              controller.enqueue(encodedFrame); // fallback
            }
          }
        }
      });
    } else {
      console.warn("RTCRtpScriptTransform non supportato: invio in chiaro.");
    }
  }

  // ✳️ DECIFRATURA lato ricezione (Decrypt)
  pc2.addEventListener("track", ev => {
    for (const rx of pc2.getReceivers()) {
      if (hasScriptTransform()) {
        console.log("Applying decryption transform on", rx.track.kind);
        // @ts-ignore
        rx.transform = new RTCRtpScriptTransform({
          transformer: {
            transform: (encodedFrame, controller) => {
              try {
                const input = new Uint8Array(encodedFrame.data);
                const out = rx.track.kind === "video"
                  ? peer.decrypt_video(input)
                  : peer.decrypt_audio(input);
                encodedFrame.data = out.buffer;
                controller.enqueue(encodedFrame);
              } catch (e) {
                console.error("Decrypt transform error:", e);
                controller.enqueue(encodedFrame); // fallback
              }
            }
          }
        });
      } else {
        console.warn("RTCRtpScriptTransform non supportato: ricevo in chiaro.");
      }
    }
  });

  // Completa handshake WebRTC
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);

  console.log("Loopback con SFrame attivo ✅");
  if (info) info.textContent = "SFrame attivo: cifratura e decifratura locali.";
};
