// sframe_layer.js
// Layer SFrame / crypto (HKDF + WasmPeer + encoded transforms)

import { hkdf } from './hkdf.js';
import { els, log, logSFrame } from './ui.js';
import { initLocalMlsSession } from './mls_sframe_session.js';
let currentSession = null;


// KID fissati: 1=audio, 2=video
// In futuro: schema KID derivato da MLS (baseKid + sender_index)
const KID_AUDIO = 1;
const KID_VIDEO = 2;

// Secret base di sviluppo (in futuro: exporter da MLS / gruppo)
const BASE_SECRET = new TextEncoder().encode('DEV-ONLY-BASE-SECRET');

// TX peer locale (usato per cifrare i frame che inviamo)
let txPeer = null;

/**
 * Deriva un secret per-mittente a partire dall’etichetta logica
 * (nel nostro caso: displayName = identity nella room).
 *
 * In futuro, al posto di BASE_SECRET, si userà un exporter da MLS.
 */
async function deriveSenderSecret(senderLabel) {
  return hkdf(BASE_SECRET, `sender=${senderLabel}`);
}

/**
 * Inizializza il WasmPeer per TX locale, se non esiste.
 * Ritorna true se TX SFrame è pronto, false se invieremo in chiaro.
 */
export async function ensureTxPeerForLocal() {
  if (txPeer) return true;

  if (!window.SFRAME?.WasmPeer) {
    log('⚠️ SFRAME non pronto, TX in chiaro.');
    return false;
  }

  let disp = (els.displayName.value || '').trim();
  if (!disp) {
    disp = 'user-' + Math.random().toString(36).slice(2, 8);
    els.displayName.value = disp;
  }

  // 1) crea la "sessione MLS"
  currentSession = await initLocalMlsSession(disp);

  log(`MLS-session: baseKid=${currentSession.baseKid}`);

  txPeer = new window.SFRAME.WasmPeer(
    currentSession.kidAudio,
    currentSession.kidVideo,
    null,
    currentSession.audioSecret, // secret per audio
    currentSession.videoSecret  // secret per video
  );

  log('Local SFrame TX peer pronto (segreti + KID dinamici)');
  return true;
}


/**
 * Inizializza, se necessario, il WasmPeer RX per un certo feed remoto.
 * `sub` è l’oggetto subscriber { feedId, display, rxPeer, ... }.
 */
export async function ensureRxPeerForFeed(sub) {
  if (sub.rxPeer) return true;

  if (!window.SFRAME?.WasmPeer) {
    log(`RX SFrame non pronto per feed ${sub.feedId}, decifrando in chiaro.`);
    return false;
  }

  // Usa la stessa derivazione deterministica vista nel nativo
  const disp = sub.display || String(sub.feedId);

  const rxAudioSecret = await hkdf(currentSession.masterSecret, `audio:${disp}`);
  const rxVideoSecret = await hkdf(currentSession.masterSecret, `video:${disp}`);

  // usa stessi KID
  const kidA = currentSession.baseKid;
  const kidV = currentSession.baseKid + 1;

  sub.rxPeer = window.SFRAME.WasmPeer.new_full_duplex(
    999, 998,     // TX dummy
    kidA,
    kidV,
    null,
    rxAudioSecret,
    rxVideoSecret
  );

  log(`SFrame RX peer pronto per feed=${sub.feedId} (segreti dinamici)`);
  return true;
}


/**
 * Attacca encoded transform lato sender (TX).
 */
export function attachSenderTransform(sender, kind) {
  if (!sender) {
    log('attachSenderTransform: sender mancante per', kind);
    return;
  }
  if (typeof sender.createEncodedStreams !== 'function') {
    log('⚠️ sender.createEncodedStreams non disponibile per ' + kind);
    return;
  }

  let streams;
  try {
    streams = sender.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(TX) ha lanciato su ' + kind + ': ' + (e.message || e));
    console.warn('createEncodedStreams sender error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform TX attaccato su', kind);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!txPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);
        let outU8;

        if (kind === 'audio') {
          outU8 = txPeer.encrypt_audio(inU8);
        } else {
          outU8 = txPeer.encrypt_video(inU8);
        }

        // Log opzionale header SFrame TX
        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const info = window.SFRAME.inspect(outU8);
            logSFrame(`[TX/${kind}] ${info}`);
          } catch {}
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('encrypt err', e);
        controller.enqueue(chunk);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo TX err', e);
  });
}

/**
 * Attacca encoded transform lato receiver (RX) per uno specifico subscriber.
 *
 * `sub` deve avere sub.rxPeer già inizializzato (ensureRxPeerForFeed).
 */
export function attachReceiverTransform(receiver, kind, sub) {
  if (!receiver) {
    log('attachReceiverTransform: receiver mancante per', kind, 'feed=', sub.feedId);
    return;
  }
  if (typeof receiver.createEncodedStreams !== 'function') {
    log('⚠️ receiver.createEncodedStreams non disponibile per ' + kind + ' feed=' + sub.feedId);
    return;
  }

  let streams;
  try {
    streams = receiver.createEncodedStreams();
  } catch (e) {
    log('⚠️ createEncodedStreams(RX) ha lanciato su ' + kind + ' feed=' + sub.feedId + ': ' + (e.message || e));
    console.warn('createEncodedStreams receiver error', e);
    return;
  }

  const { readable, writable } = streams;
  log('Encoded transform RX attaccato su', kind, 'feed=', sub.feedId);

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (!sub.rxPeer || !window.SFRAME) {
          controller.enqueue(chunk);
          return;
        }

        const inU8 = new Uint8Array(chunk.data);

        // Log opzionale header SFrame RX
        if (window.SFRAME.inspect && Math.random() * 20 < 1) {
          try {
            const hdrInfo = window.SFRAME.inspect(inU8);
            logSFrame(`[RX/${kind} feed=${sub.feedId}] ${hdrInfo}`);
          } catch {}
        }

        let outU8;
        if (kind === 'audio') {
          outU8 = sub.rxPeer.decrypt_audio(inU8);
        } else {
          outU8 = sub.rxPeer.decrypt_video(inU8);
        }

        chunk.data = outU8.buffer;
        controller.enqueue(chunk);
      } catch (e) {
        console.warn('decrypt err', e);
        controller.enqueue(chunk);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable).catch(e => {
    console.warn('pipeTo RX err', e);
  });
}

/**
 * Cleanup opzionale per il TX peer (chiamato da fuori in cleanup globale).
 */
export function freeTxPeer() {
  if (txPeer && txPeer.free) {
    try { txPeer.free(); } catch {}
  }
  txPeer = null;
}
