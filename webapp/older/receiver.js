import init, { WasmPeer } from "./pkg/sframe_core.js";

const $ = s => document.querySelector(s);
const remote = $("#remote");
const btnPrep = $("#prep");
const txtOffer = $("#offer");
const btnSetOffer = $("#setOffer");
const txtAnswer = $("#answer");

function hasScriptTransform() {
  return typeof window.RTCRtpScriptTransform === "function";
}

let pc;
let recvPeer;

btnPrep.onclick = async () => {
  btnPrep.disabled = true;
  await init();

  const secret = $("#secret").value;
  const suite = $("#suite").value || null;

  // u32 se hai aggiornato lib.rs; altrimenti BigInt
  const peer = new WasmPeer(1, 2, suite, new TextEncoder().encode(secret));
  recvPeer = peer;

  pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

  pc.ontrack = (ev) => {
    remote.srcObject = ev.streams[0];
    remote.play().catch(()=>{});

    // Trova il receiver e applica la transform di decifratura
    const rx = pc.getReceivers().find(r => r.track === ev.track);
    if (!rx) return;

    if (hasScriptTransform()) {
      // @ts-ignore
      rx.transform = new RTCRtpScriptTransform({
        transformer: {
          transform: (encodedFrame, controller) => {
            const input = new Uint8Array(encodedFrame.data);
            const out = rx.track.kind === "video"
              ? peer.decrypt_video(input)
              : peer.decrypt_audio(input);
            encodedFrame.data = out.buffer;
            controller.enqueue(encodedFrame);
          }
        }
      });
    } else {
      console.warn("RTCRtpScriptTransform non supportato: ricevo in chiaro");
    }
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate && pc.localDescription) {
      txtAnswer.value = JSON.stringify(pc.localDescription);
    }
  };

  console.log("Receiver pronto: incolla l'Offer e premi Set Remote Offer");
};

btnSetOffer.onclick = async () => {
  const off = JSON.parse(txtOffer.value);
  await pc.setRemoteDescription(off);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  // l’ICE gathering completa e riempie txtAnswer quando finisce
  console.log("Answer creata, copiala nel Sender.");
};
