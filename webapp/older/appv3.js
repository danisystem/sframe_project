console.log("[BOOT] appv3.js loaded");
const $ = (s) => document.querySelector(s);
const dbg = $("#debug");
const log = (...a) => { console.log("[app]", ...a); dbg.textContent += "\n" + a.join(" "); };

import init, { WasmPeer } from "./pkg/sframe_core.js";
await init();

const startBtn = $("#start");
const unmuteBtn = $("#unmute");
const local = $("#local");
const remote = $("#remote");
const remoteAudio = $("#remoteAudio");

// ------- MediaSource helpers (video VP8, audio Opus) -------
const MSE = {
  video: {
    ms: null, sb: null, queue: [], inited: false,
    mime: "video/webm; codecs=vp8",
    attach(el) {
      if (!("MediaSource" in window) || !MediaSource.isTypeSupported(this.mime)) {
        log("MSE video non supportato, fallback disabilitato");
        return false;
      }
      this.ms = new MediaSource();
      el.src = URL.createObjectURL(this.ms);
      this.ms.addEventListener("sourceopen", () => {
        this.sb = this.ms.addSourceBuffer(this.mime);
        this.sb.mode = "segments";
        this.sb.addEventListener("updateend", () => this._drain());
        this.inited = true;
        this._drain();
      });
      return true;
    },
    push(chunk) {
      this.queue.push(chunk);
      this._drain();
    },
    _drain() {
      if (!this.inited || !this.sb || this.sb.updating) return;
      const next = this.queue.shift();
      if (!next) return;
      try { this.sb.appendBuffer(next); } catch (e) { log("MSE video append err", e); }
    }
  },
  audio: {
    ms: null, sb: null, queue: [], inited: false,
    mime: "audio/webm; codecs=opus",
    attach(el) {
      if (!("MediaSource" in window) || !MediaSource.isTypeSupported(this.mime)) {
        log("MSE audio non supportato, fallback disabilitato");
        return false;
      }
      this.ms = new MediaSource();
      el.src = URL.createObjectURL(this.ms);
      this.ms.addEventListener("sourceopen", () => {
        this.sb = this.ms.addSourceBuffer(this.mime);
        this.sb.mode = "segments";
        this.sb.addEventListener("updateend", () => this._drain());
        this.inited = true;
        this._drain();
      });
      return true;
    },
    push(chunk) {
      this.queue.push(chunk);
      this._drain();
    },
    _drain() {
      if (!this.inited || !this.sb || this.sb.updating) return;
      const next = this.queue.shift();
      if (!next) return;
      try { this.sb.appendBuffer(next); } catch (e) { log("MSE audio append err", e); }
    }
  }
};

// ------- START -------
startBtn.onclick = async () => {
  if (!window.isSecureContext) { alert("Apri la pagina da http://localhost o HTTPS (getUserMedia)."); return; }
  if (!navigator.mediaDevices?.getUserMedia) { alert("getUserMedia non disponibile."); return; }

  const wsUrl = $("#wsurl").value.trim();
  const secret = $("#secret").value.trim();
  const suite = null;

  const role = prompt("Peer (A o B)?", "A").toUpperCase();
  const map = role === "A"
    ? { tx: { a:101, v:102 }, rx: { a:201, v:202 } }
    : { tx: { a:201, v:202 }, rx: { a:101, v:102 } };

  log(`Avvio ${role} → TX[a=${map.tx.a},v=${map.tx.v}] RX[a=${map.rx.a},v=${map.rx.v}]`);

  const enc = new TextEncoder().encode(secret);
  const peerTX = new WasmPeer(map.tx.a, map.tx.v, suite, enc);
  const peerRX = new WasmPeer(map.rx.a, map.rx.v, suite, enc);

  // WS
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => log(`WS connected ${wsUrl}`);
  ws.onerror = (e) => log("WS error", e);
  ws.onclose = () => log("WS closed");

  // Attacca MediaSource (una volta sola)
  const videoOk = MSE.video.attach(remote);
  const audioOk = MSE.audio.attach(remoteAudio);

  // RX: ricevi chunk cifrati e push in MSE dopo decrypt
  ws.onmessage = async (ev) => {
    const buf = new Uint8Array(await ev.data);
    log(`[RX] chunk ${buf.length} bytes`);
    // Prova video poi audio
    try {
      const plain = peerRX.decrypt_video(buf);
      log(`[RX] decrypt video OK (${plain.length}B)`);
      if (videoOk) MSE.video.push(plain);
      return;
    } catch {}
    try {
      const plain = peerRX.decrypt_audio(buf);
      log(`[RX] decrypt audio OK (${plain.length}B)`);
      if (audioOk) MSE.audio.push(plain);
      return;
    } catch (e) {
      log("RX decrypt fail", e);
    }
  };

  // TX: acquisisci e invia
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
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
      log(`[TX] ${track.kind} ${data.length}B → enc ${out.length}B`);
      ws.send(out);
    } catch (e) {
      log("Encrypt/send fail", e);
    }
  };

  // Usa MediaRecorder per produrre segmenti WebM (VP8/Opus)
  stream.getTracks().forEach(track => {
    // Per sicurezza: lascia che il browser scelga il mime supportato
    let options = {};
    try {
      const preferred = track.kind === "video" ? "video/webm;codecs=vp8" : "audio/webm;codecs=opus";
      options = MediaRecorder.isTypeSupported(preferred) ? { mimeType: preferred } : {};
    } catch { options = {}; }

    const rec = new MediaRecorder(new MediaStream([track]), options);
    rec.ondataavailable = async e => {
      if (e.data && e.data.size > 0) {
        const raw = new Uint8Array(await e.data.arrayBuffer());
        log(`[TX] raw ${track.kind} ${raw.length}B`);
        await sendFrame(track, raw);
      }
    };
    rec.onerror = e => log(`[TX] recorder error ${track.kind}:`, e.error || e);
    rec.start(250); // segmentazione 250ms
    log(`[TX] recorder start (${track.kind})`);
  });
};

// ------- UNMUTE -------
unmuteBtn.onclick = async () => {
  try {
    remote.muted = false;
    await remote.play();
    await remoteAudio.play();
    log("Unmute OK (video+audio)");
  } catch (e) {
    log("Unmute error", e);
  }
};
