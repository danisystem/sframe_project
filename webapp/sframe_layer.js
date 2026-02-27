// sframe_layer.js
// -------------------------------------------------------------
// Layer JavaScript sopra il modulo WASM sframe_core
//
// Responsabilità:
// - Inizializzare il runtime WASM (se non già fatto da bootstrap_sframe.js)
// - Esporre funzioni di alto livello per creare i peer SFrame:
//   * createTxPeer(kidAudio, kidVideo, txKey)
//   * createRxPeer(txKidDummyA, txKidDummyV, kidAudio, kidVideo, rxKey)
//
// NOTA:
// bootstrap_sframe.js importa già sframe_core.js e lo inizializza
// a livello globale. Qui gestiamo il caso in cui il bootstrap non sia
// ancora stato eseguito (o in contesti di test), evitando doppie
// inizializzazioni inutili.
// -------------------------------------------------------------

import initWasm, {
  WasmPeer,
  sframe_inspect,
} from "./pkg/sframe_core.js";

import { Output } from "./output.js";

let wasmReady = false;

/**
 * Inizializza il modulo SFrame WASM (idempotente).
 *
 * Possibili scenari:
 * - bootstrap_sframe.js ha già eseguito init() e creato window.SFRAME:
 *   → segniamo solo wasmReady = true.
 * - Altrimenti chiamiamo initWasm() qui e popoliamo window.SFRAME.
 */
export async function initSFrame() {
  if (wasmReady) {
    return;
  }

  // Caso 1: bootstrap_sframe.js ha già creato window.SFRAME
  if (window.SFRAME && window.SFRAME.WasmPeer) {
    wasmReady = true;
    Output.sframe("WASM SFrame already initialized (bootstrap)");
    return;
  }

  // Caso 2: inizializziamo noi il runtime WASM
  try {
    await initWasm(); // Carica sframe_core_bg.wasm

    window.SFRAME = {
      WasmPeer,
      inspect: sframe_inspect,
    };

    wasmReady = true;
    Output.sframe("WASM SFrame initialized");
  } catch (e) {
    Output.error("SFrame init failed", e);
  }
}

/**
 * Crea un peer SFrame per la trasmissione (TX) di audio + video.
 *
 * - kidAudio / kidVideo:
 *   KID SFrame per le due tracce TX.
 * - txKey:
 *   Chiave simmetrica derivata da MLS (HKDF).
 *
 * Ritorna un'istanza di WasmPeer oppure null in caso di errore.
 */
export function createTxPeer(kidAudio, kidVideo, txKey) {
  try {
    const peer = new WasmPeer(kidAudio, kidVideo, null, txKey);

    Output.sframe("TX Peer created", { kidAudio, kidVideo });

    return peer;
  } catch (e) {
    Output.error("TX Peer creation failed", e);
    return null;
  }
}

/**
 * Crea un peer SFrame per la ricezione (RX) di audio + video.
 *
 * - txKidDummyA / txKidDummyV:
 *   KID “fittizi” per la direzione TX di questo peer
 *   (non usati nella webapp, ma richiesti dal costruttore full-duplex di WasmPeer).
 *
 * - kidAudio / kidVideo:
 *   KID SFrame utilizzati per la decryption dei flussi
 *   provenienti dal sender remoto.
 *
 * - rxKey:
 *   Chiave simmetrica derivata da MLS per quel sender_index remoto.
 *
 * Ritorna un'istanza di WasmPeer oppure null in caso di errore.
 */
export function createRxPeer(
  txKidDummyA,
  txKidDummyV,
  kidAudio,
  kidVideo,
  rxKey
) {
  try {
    const peer = WasmPeer.new_full_duplex(
      txKidDummyA,
      txKidDummyV,
      kidAudio,
      kidVideo,
      null,
      rxKey
    );

    Output.sframe("RX Peer created", { kidAudio, kidVideo });

    return peer;
  } catch (e) {
    Output.error("RX Peer creation failed", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TODO (miglioramento API WASM):
// Oggi WasmPeer è sempre full-duplex (Sender+Receiver per audio/video).
// Per creare un peer RX-only siamo costretti a usare WasmPeer.new_full_duplex()
// passando KID TX "dummy", perché l'API WASM non espone un costruttore RX-only.(tutto era dovuto
// al fatto che prima era tutto statico e uguale kid chiavi e si è usato un approccio incrementale.)
//
// Miglioria consigliata in src/lib.rs:
//   - esporre un WasmTxPeer (solo Sender audio/video) con ctor(txKidA, txKidV, suite, secret)
//   - esporre un WasmRxPeer (solo Receiver audio/video) con ctor(rxKidA, rxKidV, suite, secret)
//
// Benefici:
//   - elimina i dummy KID
//   - rende esplicita la direzione (TX vs RX)
//   - riduce errori d'uso e semplifica sframe_layer.js
// ---------------------------------------------------------------------------
