export async function hkdf(secret, info, outLen=32) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'HKDF', hash:'SHA-256', salt:new Uint8Array([]),
      info: new TextEncoder().encode(info) },
    key, outLen*8
  );
  return new Uint8Array(bits);
}
