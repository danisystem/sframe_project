// appLK.js
// PRIMA (CDN generico)  -> falliva
// from "https://cdn.jsdelivr.net/npm/@livekit/client/+esm"
// from "https://esm.sh/@livekit/client@^2"

// DOPO (ESM esplicito unpkg, versione recente)
import {
  Room, RoomEvent, createLocalAudioTrack, createLocalVideoTrack,
} from "https://unpkg.com/livekit-client@2.15.16/dist/livekit-client.esm.mjs";


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
  const text = await res.text();
  return text; // è un JWT in chiaro
}

async function join() {
  try{
    if (room) return;
    room = new Room();

    // Eventi principali
    room
      .on(RoomEvent.ParticipantConnected, p => log('Partecipante connesso:', p.identity))
      .on(RoomEvent.ParticipantDisconnected, p => log('Partecipante disconnesso:', p.identity))
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        log('Track subscribed:', publication.kind, 'da', participant.identity);
        attachTrack(track, els.videos);
      })
      .on(RoomEvent.Disconnected, () => {
        log('Disconnesso dalla room');
        cleanup();
      });

    const token = await getToken(els.tokenUrl.value, els.room.value, els.identity.value || 'Danilo');
    log('Token OK (len):', token.length);

    // Connessione al server LiveKit
    await room.connect(els.serverUrl.value, token);
    log('Connesso a LiveKit:', els.serverUrl.value, 'room=', room.name);

    // Crea tracce locali
    localMic = await createLocalAudioTrack();
    localCam = await createLocalVideoTrack();
    await room.localParticipant.publishTrack(localMic);
    await room.localParticipant.publishTrack(localCam);
    log('Pubblicate tracce locali (mic+cam)');

    // Mostra preview locale
    const camEl = attachTrack(localCam, els.local);
    camEl.muted = true; // evita eco locale

    setUIConnected(true);

    // TODO (Fase SFrame): qui aggiungeremo l'aggancio Insertable Streams per cifrare i frame
    // Esempio placeholder:
    // await enableSFrameForLocalPublications(room);
    // room.on(RoomEvent.TrackSubscribed, async (track, pub, participant) => {
    //   await enableSFrameForRemoteTrack(track);
    // });
  }catch(err){
    log('ERRORE join:', err.message || err);
    cleanup();
  }
}

async function leave(){
  try{
    if(!room) return;
    await room.disconnect();
  }catch(e){}
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
  if(!room) return;
  const lp = room.localParticipant;
  const pub = lp.getTrackPublications().find(p => p.kind === 'audio');
  if(!pub) return;
  if (pub.isMuted) {
    await lp.unmuteTrack(pub.track);
    log('Mic UNMUTED');
  } else {
    await lp.muteTrack(pub.track);
    log('Mic MUTED');
  }
}

async function toggleCam(){
  if(!room) return;
  const lp = room.localParticipant;
  const pub = lp.getTrackPublications().find(p => p.kind === 'video');
  if(!pub) return;
  if (pub.isMuted) {
    await lp.unmuteTrack(pub.track);
    log('Cam ON');
  } else {
    await lp.muteTrack(pub.track);
    log('Cam OFF');
  }
}

els.btnJoin.addEventListener('click', join);
els.btnLeave.addEventListener('click', leave);
els.btnToggleMic.addEventListener('click', toggleMic);
els.btnToggleCam.addEventListener('click', toggleCam);

// Utility: disabilita UI all'avvio
setUIConnected(false);
log('appLK pronta. 1) Avvia LiveKit docker. 2) Avvia token server. 3) Premi Join.');
