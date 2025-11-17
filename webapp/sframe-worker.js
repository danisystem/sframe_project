// sframe-worker.js (module worker)
import init, { WasmPeer, sframe_inspect } from './pkg/sframe_core.js';

// Stato interno worker
let role = null;     // 'send' | 'recv'
let kind = null;     // 'audio' | 'video'
let peer = null;     // WasmPeer
let ready = false;
let doInspect = true;

// inizializzazione dal main thread
self.onmessage = async (e) => {
  const { type, data } = e.data || {};
  if (type === 'init') {
    // data: { role, kind, secret (Uint8Array-like), inspect }
    await init(); // inizializza wasm_bindgen
    role = data.role;
    kind = data.kind;
    doInspect = !!data.inspect;
    const secret = new Uint8Array(data.secret);

    // KID fissi: 1 audio, 2 video
    if (role === 'send') {
      // TX: un WasmPeer con KID_AUDIO=1, KID_VIDEO=2
      peer = new WasmPeer(1, 2, null, secret);
    } else {
      // RX: full duplex, ma usiamo solo RX con kid 1/2
      peer = WasmPeer.new_full_duplex(
        99, 98,          // tx dummy
        1, 2,            // rx_audio=1, rx_video=2
        null,
        secret
      );
    }
    ready = true;
    self.postMessage({ type: 'ready', role, kind });
  } else if (type === 'setInspect') {
    doInspect = !!data.inspect;
  }
};

// funzione di trasformazione SFrame (v2 API)
self.onrtctransform = (event) => {
  const { readable, writable } = event.transformer;
  const reader = readable.getReader();
  const writer = writable.getWriter();

  (async () => {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      const chunk = r.value;

      try {
        if (!ready || !peer) {
          // finché non è pronto, passa tutto in chiaro
          await writer.write(chunk);
          continue;
        }

        const inU8 = new Uint8Array(chunk.data);
        let outU8;

        if (role === 'send') {
          outU8 = (kind === 'audio')
            ? peer.encrypt_audio(inU8)
            : peer.encrypt_video(inU8);

          if (doInspect) {
            try {
              const info = sframe_inspect(outU8);
              self.postMessage({ type: 'inspect', direction: 'TX', kind, info });
            } catch {}
          }
        } else {
          if (doInspect) {
            try {
              const info = sframe_inspect(inU8);
              self.postMessage({ type: 'inspect', direction: 'RX', kind, info });
            } catch {}
          }
          outU8 = (kind === 'audio')
            ? peer.decrypt_audio(inU8)
            : peer.decrypt_video(inU8);
        }

        chunk.data = outU8.buffer;
        await writer.write(chunk);
      } catch (e) {
        // in caso di problemi, non rompere lo stream
        await writer.write(chunk);
      }
    }
    await writer.close();
  })();
};
