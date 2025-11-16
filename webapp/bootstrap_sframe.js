import init, { WasmPeer, sframe_inspect } from './pkg/sframe_core.js';

// inizializza il modulo wasm
await init();

// Esponi una “facciata” semplice su window.
// NOTA: qui NON passiamo ctr: lo gestisce il tuo Sender/Receiver dentro WasmPeer.
window.SFRAME = {
  WasmPeer,
  inspect: (u8) => sframe_inspect(u8),
};

console.log('[bootstrap] SFRAME ready:', !!window.SFRAME.WasmPeer);
