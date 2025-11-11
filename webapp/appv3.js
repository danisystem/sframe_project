console.log("[BOOT] appv3.js loaded");
const $ = (s) => document.querySelector(s);
const dbg = $("#debug");
const log = (...a) => {
  console.log("[app]", ...a);
  dbg.textContent += "\n" + a.join(" ");
};

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
    ? { tx: { a: 101, v: 102 }, rx: { a: 201, v: 202 } }
    : { tx: { a: 201, v: 202 }, rx: { a: 101, v: 102 } };

  log(`Avvio ${role} → TX[a=${map.tx.a},v=${map.tx.v}] RX[a=${map.rx.a},v=${map.rx.v}]`);

  const enc = new TextEncoder().encode(secret);
  const peerTX = new WasmPeer(map.tx.a, map.tx.v, suite, enc);
  const peerRX = new WasmPeer(map.rx.a, map.rx.v, suite, enc);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => log(`WS connected ${wsUrl}`);

  ws.onerror = (e) => log("WS error", e);
  ws.onclose = () => log("WS closed");

  ws.onmessage = async (ev) => {
    try {
      const buf = new Uint8Array(await ev.data);
      log(`[RX] chunk ${buf.length} bytes`);

      // tenta decrypt come video
      try {
        const out = peerRX.decrypt_video(buf);
        log(`[RX] decrypt video OK (${out.length} bytes)`);
        const blob = new Blob([out], { type: "video/webm" });
        remote.src = URL.createObjectURL(blob);
      } catch (e1) {
        try {
          const out = peerRX.decrypt_audio(buf);
          log(`[RX] decrypt audio OK (${out.length} bytes)`);
          const a = new Audio(URL.createObjectURL(new Blob([out], { type: "audio/webm" })));
          a.play().catch(() => {});
        } catch (e2) {
          log("RX decrypt fail", e2);
        }
      }
    } catch (e) {
      log("RX error", e);
    }
  };

  // acquisisci camera/microfono
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    local.srcObject = stream;
    await local.play();
  } catch (e) {
    log("Errore getUserMedia", e);
    return;
  }

  const sendFrame = async (track, data) => {
    try {
      const out = track.kind === "video"
        ? peerTX.encrypt_video(data)
        : peerTX.encrypt_audio(data);

      log(`[TX] ${track.kind} chunk ${data.length}B → enc ${out.length}B`);
      ws.send(out);
    } catch (e) {
      log("Encrypt/send fail", e);
    }
  };

  // MediaRecorder fallback per browser compatibili
  stream.getTracks().forEach(track => {
    let options = {};
    try {
      options = { mimeType: "video/webm;codecs=vp8" };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = {}; // fallback automatico
      }
    } catch { options = {}; }

    const rec = new MediaRecorder(new MediaStream([track]), options);
    rec.ondataavailable = async e => {
      if (e.data && e.data.size > 0) {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        log(`[TX] raw ${track.kind} ${buf.length} bytes`);
        await sendFrame(track, buf);
      }
    };
    rec.onerror = e => log(`[TX] recorder error ${track.kind}:`, e.error || e);
    rec.start(250);
    log(`[TX] recorder start (${track.kind})`);
  });
};
