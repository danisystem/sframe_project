// sframe-worker.js  (Module Worker)
import init, { WasmPeer, sframe_inspect } from './pkg/sframe_core.js';

let role = null;        // 'send' | 'recv'
let kind = null;        // 'audio' | 'video'
let peer = null;        // WasmPeer: per 'send' usa key_audio=1,key_video=2 con secret del mittente; per 'recv' usa rx 1/2 con secret del remoto
let inspect = false;

self.onmessage = async (e) => {
  const { type, data } = e.data || {};
  if (type === 'init') {
    await init();
    role = data.role;      // 'send'|'recv'
    kind = data.kind;      // 'audio'|'video'
    inspect = !!data.inspect;

    // In 'send': creiamo WasmPeer(key_audio=1, key_video=2, secret=senderSecret)
    // In 'recv': new_full_duplex(tx dummy, rx_audio=1, rx_video=2, secret=remoteSecret)
    const secret = new Uint8Array(data.secret);
    if (role === 'send') {
      peer = new WasmPeer(1, 2, null, secret);
    } else {
      peer = WasmPeer.new_full_duplex(99, 98, 1, 2, null, secret);
    }
    self.postMessage({ type: 'ready' });
  } else if (type === 'toggle_inspect') {
    inspect = !!data.inspect;
  }
};

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
        // chunk.data è un ArrayBuffer
        const inU8 = new Uint8Array(chunk.data);
        let outU8;
        if (role === 'send') {
          outU8 = (kind === 'audio') ? peer.encrypt_audio(inU8) : peer.encrypt_video(inU8);
          if (inspect && Math.random()*30<1) {
            try { console.debug('[WKR SFrame TX]', sframe_inspect(outU8)); } catch {}
          }
        } else {
          outU8 = (kind === 'audio') ? peer.decrypt_audio(inU8) : peer.decrypt_video(inU8);
          if (inspect && Math.random()*30<1) {
            try { console.debug('[WKR SFrame RX] hdr', sframe_inspect(inU8)); } catch {}
          }
        }
        chunk.data = outU8.buffer;
        await writer.write(chunk);
      } catch (e) {
        // fall-back passthrough in caso di errore
        await writer.write(chunk);
      }
    }
    await writer.close();
  })();
};
