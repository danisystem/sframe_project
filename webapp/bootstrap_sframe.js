// bootstrap_sframe.js
// -------------------------------------------------------------
// Inizializza il modulo WASM SFrame (sframe_core.wasm)
// e rende disponibili in window.SFRAME:
// - WasmPeer → oggetto principale per cifrare/decifrare
// - inspect(packet) → funzione di debug per l'header SFrame
//
// Questo file deve essere importato UNA sola volta
// prima di appRoom.js / sframe_layer.js.
// -------------------------------------------------------------

import init, {
  WasmPeer,
  sframe_inspect as sframeInspect,
} from "./pkg/sframe_core.js";

// Evita la doppia inizializzazione (utile in hot reload o pagine complesse)
if (!window.__SFRAME_INITIALIZING__) {
  window.__SFRAME_INITIALIZING__ = true;

  (async () => {
    try {
      // Carica e inizializza sframe_core_bg.wasm
      await init();

      // Espone le API globali
      window.SFRAME = {
        WasmPeer,
        inspect: sframeInspect,
      };

      console.log(
        "[bootstrap_sframe] SFrame WASM initialized:",
        !!window.SFRAME.WasmPeer
      );
    } catch (e) {
      console.error("[bootstrap_sframe] Errore inizializzazione WASM:", e);

      // In caso di errore grave, window.SFRAME rimane undefined.
      // La webapp (sframe_layer.js / appRoom.js) deve fallire gentilmente.
    }
  })();
}