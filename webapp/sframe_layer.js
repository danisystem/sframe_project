// sframe_layer.js
// -------------------------------------------------------------
// Layer JavaScript sopra il modulo WASM sframe_core
// -------------------------------------------------------------

import initWasm, {
  WasmPeer,
  sframe_inspect,
} from "./pkg/sframe_core.js";

import { Output } from "./output.js";

// Variabile per evitare race-conditions durante il caricamento WASM
let initPromise = null;

/**
 * Inizializza il modulo SFrame WASM (idempotente e thread-safe per l'event loop).
 */
export async function initSFrame() {
  // Caso 1: è già stato inizializzato (da noi o da bootstrap_sframe.js)
  if (window.SFRAME && window.SFRAME.WasmPeer) {
    return;
  }

  // Caso 2: qualcuno ha già avviato l'inizializzazione e stiamo aspettando
  if (initPromise) {
    return initPromise;
  }

  // Caso 3: siamo i primi a richiederlo, avviamo il download/parsing del WASM
  initPromise = (async () => {
    try {
      await initWasm(); // Carica sframe_core_bg.wasm

      window.SFRAME = {
        WasmPeer,
        inspect: sframe_inspect,
      };

      Output.sframe("WASM SFrame initialized");
    } catch (e) {
      Output.error("SFrame init failed", e);
      initPromise = null; // In caso di errore, resettiamo per permettere nuovi tentativi
      throw e; 
    }
  })();

  return initPromise;
}

/**
 * Crea un peer SFrame per la trasmissione (TX) di audio + video.
 */
export function createTxPeer(kidAudio, kidVideo, txKey) {
  try {
    // FIX: Convertiamo i numeri in BigInt per soddisfare il tipo u64 in Rust
    const peer = new WasmPeer(
      BigInt(kidAudio),
      BigInt(kidVideo),
      null,
      txKey
    );
    Output.sframe("TX Peer created", { kidAudio, kidVideo });
    return peer;
  } catch (e) {
    Output.error("TX Peer creation failed", e);
    return null;
  }
}

/**
 * Crea un peer SFrame per la ricezione (RX) di audio + video.
 */
export function createRxPeer(
  txKidDummyA,
  txKidDummyV,
  kidAudio,
  kidVideo,
  rxKey
) {
  try {
    // FIX: Convertiamo tutti i KID in BigInt
    const peer = WasmPeer.new_full_duplex(
      BigInt(txKidDummyA),
      BigInt(txKidDummyV),
      BigInt(kidAudio),
      BigInt(kidVideo),
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