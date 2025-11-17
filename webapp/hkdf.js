// hkdf.js
const enc = new TextEncoder();

/**
 * HKDF-SHA256(baseSecret, info) -> Uint8Array(32)
 * baseSecret: Uint8Array
 * info: string
 */
export async function hkdf(baseSecret, info) {
  const key = await crypto.subtle.importKey(
    'raw',
    baseSecret,
    'HKDF',
    false,
    ['deriveBits'],
  );

  // salt fisso zero (demo); in futuro si può variare
  const salt = new Uint8Array(32);
  const infoBytes = enc.encode(info);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: infoBytes,
    },
    key,
    32 * 8, // 32 byte
  );

  return new Uint8Array(bits);
}
