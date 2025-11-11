console.log("[BOOT] appv3.js loaded");
const $ = (s) => document.querySelector(s);
const dbg = $("#debug");
const log = (...a) => { console.log("[app]", ...a); dbg.textContent += "\n" + a.join(" "); };

import init, { WasmPeer, sframe_inspect } from "./pkg/sframe_core.js";

await init();

const startBtn = $("#start");
const local = $("#local");
const remote = $("#remote");

startBtn.onclick = async () => {
  const wsUrl = $("#wsurl").value.trim();
  const secret = $("#secret").value.trim();
  const suite = null;

  const role = prompt("Peer (A o B)?", "A").toUpperCase();
  const map = role === "A"
    ? { tx: {a:101,v:102}, rx: {a:201,v:202} }
    : { tx: {a:201,v:202}, rx: {a:101,v:102} };

  log(`Avvio ${role} → TX[a=${map.tx.a},v=${map.tx.v}] RX[a=${map.rx.a},v=${map.rx.v}]`);

  const enc = new TextEncoder().encode(secret);
  const peerTX = new WasmPeer(map.tx.a, map.tx.v, suite, enc);
  const peerRX = new WasmPeer(map.rx.a, map.rx.v, suite, enc);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => log("WS connected", wsUrl);

  ws.onmessage = (ev) => {
    const buf = new Uint8Array(ev.data);
    try {
      // Tenta di decifrare come video (header SFrame dirà il tipo)
      const out = peerRX.decrypt_video(buf);
      const blob = new Blob([out], { type: "video/webm" });
      remote.src = URL.createObjectURL(blob);
    } catch {
      try {
        const out = peerRX.decrypt_audio(buf);
        const blob = new Blob([out], { type: "audio/webm" });
        const a = new Audio(URL.createObjectURL(blob));
        a.play().catch(()=>{});
      } catch (e) {
        log("RX decrypt fail", e);
      }
    }
  };

  // Acquisisci camera/microfono
  const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  local.srcObject = stream;
  await local.play();

  const sendFrame = async (track, data) => {
    try {
      const out = track.kind === "video"
        ? peerTX.encrypt_video(data)
        : peerTX.encrypt_audio(data);
      ws.send(out);
    } catch (e) { log("Encrypt/send fail", e); }
  };

  // Qui uso MediaRecorder come sorgente semplificata (chunk = frame cifrato)
  stream.getTracks().forEach(track => {
    const rec = new MediaRecorder(new MediaStream([track]), { mimeType:"video/webm;codecs=vp8" });
    rec.ondataavailable = async e => {
      if (e.data && e.data.size > 0) {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        await sendFrame(track, buf);
      }
    };
    rec.start(250); // invia chunk ogni 250 ms
  });
};
