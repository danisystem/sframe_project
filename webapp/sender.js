import init, { WasmPeer } from "./pkg/sframe_core.js";

const $ = s => document.querySelector(s);
const local = $("#local");
const btnStart = $("#start");
const txtOffer = $("#offer");
const txtAnswer = $("#answer");
const btnSetAnswer = $("#setAnswer");

function hasScriptTransform() {
  return typeof window.RTCRtpScriptTransform === "function";
}

let pc;
let senderPeer;

btnStart.onclick = async () => {
  btnStart.disabled = true;

  await init();

  const secret = $("#secret").value;
  const suite = $("#suite").value || null;

  // Se il costruttore wasm accetta u32:
  const peer = new WasmPeer(1, 2, suite, new TextEncoder().encode(secret));
  // Se accetta u64: usa BigInt -> new WasmPeer(1n, 2n, suite, ...)

  senderPeer = peer;

  // RTCPeerConnection con STUN pubblico (aiuta in LAN)
  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

  // Stream locale
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  local.srcObject = stream;
  await local.play().catch(()=>{});

  for (const track of stream.getTracks()) {
    const sender = pc.addTrack(track, stream);

    if (hasScriptTransform()) {
      // @ts-ignore
      sender.transform = new RTCRtpScriptTransform({
        transformer: {
          transform: (encodedFrame, controller) => {
            const input = new Uint8Array(encodedFrame.data);
            const out = track.kind === "video"
              ? peer.encrypt_video(input)
              : peer.encrypt_audio(input);
            encodedFrame.data = out.buffer;
            controller.enqueue(encodedFrame);
          }
        }
      });
    } else {
      console.warn("RTCRtpScriptTransform non supportato: invio in chiaro");
    }
  }

  pc.onicecandidate = (e) => {
    if (!e.candidate && pc.localDescription) {
      txtOffer.value = JSON.stringify(pc.localDescription);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // l’ICE gathering completa e riempie txtOffer quando finisce
};

btnSetAnswer.onclick = async () => {
  const ans = JSON.parse(txtAnswer.value);
  await pc.setRemoteDescription(ans);
  console.log("Remote answer applicata ✅");
};
