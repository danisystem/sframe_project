// hkdf.js
// -----------------------------------------------------------------------------
// HKDF-HMAC-SHA256 per deriveTxKey / deriveRxKey (lato webapp).
//
// API:
//   export async function hkdf(master, label, length)
//
// - master: Uint8Array (IKM, tipicamente master_secret MLS)
// - label: string (info / contesto)
// - length: numero di byte richiesti
//
// Implementazione basata su WebCrypto (crypto.subtle HKDF).
// Richiede:
//   - browser moderno
//   - contesto sicuro (HTTPS)
// -----------------------------------------------------------------------------

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);

  throw new Error("hkdf: IKM non è Uint8Array / Array");
}

function utf8Encode(str) {
  return new TextEncoder().encode(str);
}

/**
 * HKDF-HMAC-SHA256 (WebCrypto).
 *
 * - salt = 0^32 (all-zero, 32 byte)
 * - label viene usato come campo "info" (UTF-8)
 */
export async function hkdf(master, label, length) {
  if (
    typeof crypto === "undefined" ||
    !crypto.subtle ||
    (typeof isSecureContext !== "undefined" && !isSecureContext)
  ) {
    throw new Error(
      "hkdf: WebCrypto HKDF non disponibile (serve browser moderno in HTTPS)"
    );
  }

  const ikmBytes = toUint8Array(master);
  const infoBytes = utf8Encode(label);
  const L = length >>> 0; // forza unsigned 32-bit

  const hashLen = 32; // SHA-256 output size
  const zeroSalt = new Uint8Array(hashLen); // salt = 32 byte a zero

  // Importiamo l'IKM come chiave HKDF
  const key = await crypto.subtle.importKey(
    "raw",
    ikmBytes,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  // Deriviamo L byte (L * 8 bit)
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: zeroSalt,
      info: infoBytes,
    },
    key,
    L * 8
  );

  return new Uint8Array(bits);
}