import {
  Room, RoomEvent, createLocalAudioTrack, createLocalVideoTrack,
} from "https://unpkg.com/livekit-client@2.15.16/dist/livekit-client.esm.mjs";
import { hkdf } from './hkdf.js';

const KID_AUDIO = 1;
const KID_VIDEO = 2;
const BASE_SECRET = new TextEncoder().encode('DEV-ONLY-BASE-SECRET');

const els = {
  room: document.getElementById('room'),
  identity: document.getElementById('identity'),
  tokenUrl: document.getElementById('tokenUrl'),
  serverUrl: document.getElementById('serverUrl'),
  btnJoin: document.getElementById('btnJoin'),
  btnLeave: document.getElementById('btnLeave'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  btnToggleCam: document.getElementById('btnToggleCam'),
  local: document.getElementById('local'),
  videos: document.getElementById('videos'),
  log: document.getElementById('log'),
};
function log(...a){ els.log.textContent += a.map(String).join(' ') + '\n'; els.log.scrollTop = els.log.scrollHeight; }

let room = null;
let localMic = null;
let localCam = null;

const nextTick = () => new Promise(r => requestAnimationFrame(() => r()));

// ---------- ScriptTransform helpers ----------
function supportsScriptTransform() {
  return 'RTCRtpScriptTransform' in window;
}
function setSenderTransformWithWorker(sender, role, kind, secret, inspect=false) {
  if (!supportsScriptTransform()) return false;
  const worker = new Worker('./sframe-worker.js', { type: 'module' });
  worker.postMessage({ type:'init', data:{ role, kind, secret, inspect } });
  // Chrome accetta { worker, options }, Safari usa { worker }
  try {
    sender.transform = new RTCRtpScriptTransform(worker, { kind, role });
  } catch {
    sender.transform = new RTCRtpScriptTransform(worker);
  }
  return true;
}

// ---------- Fallback encoded streams (può fallire su LiveKit) ----------
function attachEncryptEncodedStreams(sender, encryptFn) {
  if (!sender?.createEncodedStreams) return false;
  const { readable, writable } = sender.createEncodedStreams();
  const ts = new TransformStream({
    transform(chunk, controller) {
      try {
        const out = encryptFn(new Uint8Array(chunk.data));
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      } catch {
        controller.enqueue(chunk);
      }
    }
  });
  readable.pipeThrough(ts).pipeTo(writable);
  return true;
}
function attachDecryptEncodedStreams(receiver, decryptFn) {
  if (!receiver?.createEncodedStreams) return false;
  const { readable, writable } = receiver.createEncodedStreams();
  const ts = new TransformStream({
    transform(chunk, controller) {
      try {
        const out = decryptFn(new Uint8Array(chunk.data));
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      } catch {
        controller.enqueue(chunk);
      }
    }
  });
  readable.pipeThrough(ts).pipeTo(writable);
  return true;
}

function setUIConnected(connected){
  els.btnJoin.disabled = connected;
  els.btnLeave.disabled = !connected;
  els.btnToggleMic.disabled = !connected;
  els.btnToggleCam.disabled = !connected;
  els.room.disabled = connected;
  els.identity.disabled = connected;
  els.serverUrl.disabled = connected;
  els.tokenUrl.disabled = connected;
}

function attachTrack(track, container) {
  const el = track.attach();
  el.autoplay = true;
  el.playsInline = true;
  container.appendChild(el);
  return el;
}

async function getToken(tokenUrl, room, identity){
  const url = new URL(tokenUrl);
  url.searchParams.set('room', room);
  url.searchParams.set('identity', identity || ('user-' + Math.random().toString(36).slice(2)));
  const res = await fetch(url.toString());
  if(!res.ok){ throw new Error(`Token HTTP ${res.status}`); }
  return await res.text();
}

async function join() {
  try{
    if (room) return;
    if (!window.SFRAME?.WasmPeer) log('⚠️ WASM SFrame non inizializzato (bootstrap_sframe.js?)');

    room = new Room();

    room
      .on(RoomEvent.ParticipantConnected, p => log('Partecipante connesso:', p.identity))
      .on(RoomEvent.ParticipantDisconnected, p => log('Partecipante disconnesso:', p.identity))
      .on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
        const remoteId = participant.identity;
        log('Track subscribed:', publication.kind, 'da', remoteId);

        // SECRET per-mittente (remoto)
        const remoteSecret = await hkdf(BASE_SECRET, `sender=${remoteId}`);

        // Attach transform RX
        const receiver = track.getRTCRtpReceiver ? track.getRTCRtpReceiver() : track.receiver;

        // Prova ScriptTransform (worker per questa track)
        const okScript = supportsScriptTransform() && (() => {
          try {
            const worker = new Worker('./sframe-worker.js', { type:'module' });
            worker.postMessage({ type:'init', data:{ role:'recv', kind:publication.kind, secret:remoteSecret, inspect:false }});
            // Safari/Chrome: due firme possibili
            try { receiver.transform = new RTCRtpScriptTransform(worker, { kind: publication.kind, role:'recv' }); }
            catch { receiver.transform = new RTCRtpScriptTransform(worker); }
            return true;
          } catch { return false; }
        })();

        if (!okScript) {
          // Fallback v1: encodedStreams (potrebbe fallire con "too late")
          const okV1 = attachDecryptEncodedStreams(receiver, (u8) => {
            // usa un WasmPeer dedicato per la decifrazione di questa track
            const wp = window.SFRAME?.WasmPeer?.new_full_duplex(99,98,1,2,null,remoteSecret);
            if (!wp) return u8;
            return (publication.kind === 'audio') ? wp.decrypt_audio(u8) : wp.decrypt_video(u8);
          });
          if (!okV1) log('⚠️ RX: nessun meccanismo di transform disponibile');
        }

        attachTrack(track, els.videos);
      })
      .on(RoomEvent.Disconnected, () => {
        log('Disconnesso dalla room');
        cleanup();
      });

    const token = await getToken(els.tokenUrl.value, els.room.value, els.identity.value || 'Danilo');
    log('Token OK (len):', token.length);
    await room.connect(els.serverUrl.value, token);
    log('Connesso a LiveKit:', els.serverUrl.value, 'room=', room.name);

    // Tracce reali (per preview locale)
    localMic = await createLocalAudioTrack();
    localCam = await createLocalVideoTrack();
    const camEl = attachTrack(localCam, els.local);
    camEl.muted = true;

    // Pubblica le tracce reali normalmente
    const pubA = await room.localParticipant.publishTrack(localMic);
    const pubV = await room.localParticipant.publishTrack(localCam);
    log('Pubblicate tracce locali (mic+cam)');

    // Secret per-mittente locale
    const myId = room.localParticipant.identity ?? 'me';
    const mySecret = await hkdf(BASE_SECRET, `sender=${myId}`);

    // ATTACCA TRANSFORM TX
    // 1) ScriptTransform (preferito, niente "too late")
    const senderA = pubA.track?.getRTCRtpSender ? pubA.track.getRTCRtpSender() : pubA.track?.sender;
    const senderV = pubV.track?.getRTCRtpSender ? pubV.track.getRTCRtpSender() : pubV.track?.sender;

    let okSendA = false, okSendV = false;
    if (supportsScriptTransform() && senderA && senderV) {
      try { okSendA = setSenderTransformWithWorker(senderA, 'send', 'audio', mySecret, false); } catch {}
      try { okSendV = setSenderTransformWithWorker(senderV, 'send', 'video', mySecret, false); } catch {}
    }

    // 2) Fallback v1: encoded streams (può dare "too late")
    if (!okSendA && senderA) {
      const wp = window.SFRAME?.WasmPeer ? new window.SFRAME.WasmPeer(1,2,null,mySecret) : null;
      okSendA = attachEncryptEncodedStreams(senderA, (u8)=> wp ? wp.encrypt_audio(u8) : u8);
    }
    if (!okSendV && senderV) {
      const wp = window.SFRAME?.WasmPeer ? new window.SFRAME.WasmPeer(1,2,null,mySecret) : null;
      okSendV = attachEncryptEncodedStreams(senderV, (u8)=> wp ? wp.encrypt_video(u8) : u8);
    }

    if (okSendA && okSendV) log('SFrame TX attivato (ScriptTransform o fallback)');
    else log('⚠️ TX: impossibile attivare transform su almeno una traccia');

    setUIConnected(true);

  }catch(err){
    log('ERRORE join:', err?.message || err);
    cleanup();
  }
}

async function leave(){
  try{ if(!room) return; await room.disconnect(); }catch(e){}
  cleanup();
}

function cleanup(){
  try { room?.disconnect(); } catch(e){}
  room = null;

  els.local.innerHTML = '';
  els.videos.innerHTML = '';
  localMic?.stop(); localMic = null;
  localCam?.stop(); localCam = null;

  setUIConnected(false);
}

async function toggleMic(){
  if (!room) return;
  const cur = room.localParticipant.isMicrophoneEnabled;
  await room.localParticipant.setMicrophoneEnabled(!cur);
  log(`Mic ${!cur ? 'ON' : 'OFF'}`);
}
async function toggleCam(){
  if (!room) return;
  const cur = room.localParticipant.isCameraEnabled;
  await room.localParticipant.setCameraEnabled(!cur);
  log(`Cam ${!cur ? 'ON' : 'OFF'}`);
}

els.btnJoin.addEventListener('click', join);
els.btnLeave.addEventListener('click', leave);
els.btnToggleMic.addEventListener('click', toggleMic);
els.btnToggleCam.addEventListener('click', toggleCam);

setUIConnected(false);
log('appLK pronta. 1) Avvia LiveKit docker. 2) Avvia token server. 3) Premi Join.');
