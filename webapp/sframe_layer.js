// sframe_layer.js
// Inizializzazione Wasm + gestione WasmPeer TX/RX

import initWasm, { WasmPeer, sframe_inspect } from "./pkg/sframe_core.js";
import { Output } from "./output.js";

let wasmReady = false;

export async function initSFrame() {
  if (wasmReady) return;

  try {
    await initWasm();
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

// Creazione TX peer (solo audio+video)
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

// Creazione RX peer (full duplex)
export function createRxPeer(txKidDummyA, txKidDummyV, kidAudio, kidVideo, rxKey) {
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
