// hkdf.js
// Implementazione HKDF-HMAC-SHA256 in puro JS (senza crypto.subtle)
// API compatibile con la versione precedente:
//   export async function hkdf(master, label, length)
//
// - master: Uint8Array (ikm)
// - label: string (info)
// - length: numero di byte richiesti

// -----------------------------
// Utilità byte/word
// -----------------------------

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new Error("toUint8Array: tipo non supportato");
}

function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

// -----------------------------
// SHA-256 (puro JS)
// -----------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function sha256(bytes) {
  bytes = toUint8Array(bytes);
  const len = bytes.length;
  const bitLen = len * 8;

  // Padding
  const withOne = new Uint8Array(len + 1);
  withOne.set(bytes);
  withOne[len] = 0x80;

  let padLen = withOne.length;
  while ((padLen % 64) !== 56) padLen++;
  const padded = new Uint8Array(padLen + 8);
  padded.set(withOne);

  const view = new DataView(padded.buffer);
  view.setUint32(padLen + 0, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen + 4, bitLen >>> 0, false);

  // Init state
  let h0 = 0x6a09e667, h1 = 0xbb67ae85,
      h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c,
      h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let i = 0; i < padded.length; i += 64) {
    // Prepare message schedule
    for (let t = 0; t < 16; t++) {
      const offset = i + t * 4;
      w[t] = (padded[offset] << 24) |
             (padded[offset + 1] << 16) |
             (padded[offset + 2] << 8) |
             (padded[offset + 3]);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t-15], 7) ^ rotr(w[t-15], 18) ^ (w[t-15] >>> 3);
      const s1 = rotr(w[t-2], 17) ^ rotr(w[t-2], 19) ^ (w[t-2] >>> 10);
      w[t] = (w[t-16] + s0 + w[t-7] + s1) >>> 0;
    }

    // Compression
    let a = h0, b = h1, c = h2, d = h3,
        e = h4, f = h5, g = h6, h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, h0, false);
  dv.setUint32(4, h1, false);
  dv.setUint32(8, h2, false);
  dv.setUint32(12, h3, false);
  dv.setUint32(16, h4, false);
  dv.setUint32(20, h5, false);
  dv.setUint32(24, h6, false);
  dv.setUint32(28, h7, false);
  return out;
}

// -----------------------------
// HMAC-SHA256
// -----------------------------

function hmacSha256(key, data) {
  key = toUint8Array(key);
  data = toUint8Array(data);

  if (key.length > 64) {
    key = sha256(key);
  }
  const block = new Uint8Array(64);
  block.set(key);

  const oKeyPad = new Uint8Array(64);
  const iKeyPad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    oKeyPad[i] = block[i] ^ 0x5c;
    iKeyPad[i] = block[i] ^ 0x36;
  }

  const inner = new Uint8Array(iKeyPad.length + data.length);
  inner.set(iKeyPad);
  inner.set(data, iKeyPad.length);

  const innerHash = sha256(inner);

  const outer = new Uint8Array(oKeyPad.length + innerHash.length);
  outer.set(oKeyPad);
  outer.set(innerHash, oKeyPad.length);

  return sha256(outer);
}

// -----------------------------
// HKDF-HMAC-SHA256
// -----------------------------

export async function hkdf(ikm, label, length) {
  const info = utf8Encode(label);
  const ikmBytes = toUint8Array(ikm);
  const L = length >>> 0;
  const hashLen = 32;

  // HKDF-Extract: PRK = HMAC(salt = 0^32, IKM)
  const zeroSalt = new Uint8Array(hashLen);
  const prk = hmacSha256(zeroSalt, ikmBytes);

  // HKDF-Expand
  const nBlocks = Math.ceil(L / hashLen);
  let tPrev = new Uint8Array(0);
  const out = new Uint8Array(L);
  let offset = 0;

  for (let i = 1; i <= nBlocks; i++) {
    // T(i) = HMAC(PRK, T(i-1) || info || i)
    const buf = new Uint8Array(tPrev.length + info.length + 1);
    buf.set(tPrev, 0);
    buf.set(info, tPrev.length);
    buf[buf.length - 1] = i;

    const t = hmacSha256(prk, buf);
    const toCopy = Math.min(hashLen, L - offset);
    out.set(t.subarray(0, toCopy), offset);
    offset += toCopy;
    tPrev = t;
  }

  return out;
}
