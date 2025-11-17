// bootstrap_sframe.js
import init, { WasmPeer, sframe_inspect as sframeInspect } from './pkg/sframe_core.js';

(async () => {
  try {
    await init(); // inizializza il modulo wasm
    window.SFRAME = {
      WasmPeer,
      inspect: sframeInspect,
    };
    console.log('[bootstrap] SFRAME ready:', !!window.SFRAME.WasmPeer);
  } catch (e) {
    console.error('[bootstrap] errore init SFRAME:', e);
  }
})();
