// src/lib.rs
#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;
use sframe::{CipherSuite, header::SframeHeader};
use serde::Serialize;

mod sender;
mod receiver;
use sender::Sender;
use receiver::Receiver;

// ------------------------------------------------------------
// STRUTTURA DI DEBUG PER HEADER SFRAME (serializzabile verso JS)
// ------------------------------------------------------------
//
// Questa struct è pensata per essere "JSON-friendly" e viene convertita in JsValue
// usando serde-wasm-bindgen. Serve per debuggare rapidamente:
//   - KID (Key ID) usato nel pacchetto
//   - counter SFrame
//   - dimensioni delle varie parti del pacchetto
//   - header in esadecimale
//
#[derive(Serialize, Clone)]
pub struct SframeHeaderDebug {
    pub kid: u64,
    pub ctr: u64,
    pub header_len: usize,
    pub aad_len: usize,
    pub ct_len: usize,
    pub tag_len: usize,
    pub total_len: usize,
    pub header_hex: String,
}

// Ultimo header TX/RX catturato.
// Usiamo static mut + unsafe: in WASM (single-thread) è accettabile per debug.
static mut LAST_TX_HDR: Option<SframeHeaderDebug> = None;
static mut LAST_RX_HDR: Option<SframeHeaderDebug> = None;

// ------------------------------------------------------------
// FUNZIONI DI SUPPORTO (helpers)
// ------------------------------------------------------------

/// Converte una stringa (opzionale) in una CipherSuite.
/// Default: AES-GCM-256 + SHA-512 (se la stringa è assente o non riconosciuta).
fn parse_suite(s: Option<String>) -> CipherSuite {
    match s.as_deref() {
        Some("aes-gcm128-sha256") => CipherSuite::AesGcm128Sha256,
        _ => CipherSuite::AesGcm256Sha512,
    }
}

/// Cattura (e memorizza) info utili dell'header SFrame.
/// - dir_tx: true se pacchetto generato in encrypt_* (TX), false se in decrypt_* (RX)
/// - hdr: header già deserializzato
/// - packet: pacchetto completo SFrame
fn capture_header(dir_tx: bool, hdr: &SframeHeader, packet: &[u8]) {
    let header_len = hdr.len();
    let total = packet.len();

    // Corpo = (ciphertext + tag) dopo l'header
    let body = total.saturating_sub(header_len);

    // In AES-GCM il tag è tipicamente 16 byte
    let (ct_len, tag_len) = if body >= 16 { (body - 16, 16) } else { (body, 0) };

    // Rappresentazione esadecimale dell'header per debug rapido
    let header_hex = hex::encode(&packet[..header_len]);

    let dbg = SframeHeaderDebug {
        kid: hdr.key_id(),
        ctr: hdr.counter(),
        header_len,
        aad_len: header_len, // nel tuo modello AAD coincide con l'header
        ct_len,
        tag_len,
        total_len: total,
        header_hex,
    };

    unsafe {
        if dir_tx {
            LAST_TX_HDR = Some(dbg);
        } else {
            LAST_RX_HDR = Some(dbg);
        }
    }
}

// ------------------------------------------------------------
// EXPORT WASM: recupero ultimo header TX/RX (con serde-wasm-bindgen)
// ------------------------------------------------------------
//
// Queste funzioni permettono al JS di ottenere l'ultimo header visto,
// utile per debug in tempo reale senza parsing manuale in JS.
//

#[wasm_bindgen]
pub fn sframe_last_tx_header() -> JsValue {
    unsafe {
        if let Some(ref h) = LAST_TX_HDR {
            serde_wasm_bindgen::to_value(h).unwrap()
        } else {
            JsValue::UNDEFINED
        }
    }
}

#[wasm_bindgen]
pub fn sframe_last_rx_header() -> JsValue {
    unsafe {
        if let Some(ref h) = LAST_RX_HDR {
            serde_wasm_bindgen::to_value(h).unwrap()
        } else {
            JsValue::UNDEFINED
        }
    }
}

// ------------------------------------------------------------
// PEER WASM ESPORTATO VERSO JAVASCRIPT
// ------------------------------------------------------------
//
// NOTA IMPORTANTE:
// Questo oggetto contiene SEMPRE:
//   - 2 Sender (audio/video) per la cifratura
//   - 2 Receiver (audio/video) per la decifratura
//
// Quindi è intrinsecamente "full-duplex" a livello di struct.
// In JS puoi usarlo come TX-only o RX-only, ma internamente esistono entrambe
// le direzioni.
//
// ---------------------------------------------------------------------------
// TODO (miglioramento API WASM verso JS):
//
// Attualmente, per creare un peer RX-only nella webapp, siamo spesso costretti
// a chiamare new_full_duplex(...) passando anche tx_audio/tx_video (talvolta "dummy"),
// perché l'API non espone un costruttore RX-only o TX-only.
//
// Miglioria consigliata (più pulita):
//   - esportare due tipi separati:
//       * WasmTxPeer: contiene solo Sender (audio/video) ed espone solo encrypt_*
//       * WasmRxPeer: contiene solo Receiver (audio/video) ed espone solo decrypt_*
//
// In alternativa (meno invasivo):
//   - aggiungere costruttori dedicati su WasmPeer:
//       * WasmPeer::new_tx_only(tx_audio, tx_video, suite, secret)
//       * WasmPeer::new_rx_only(rx_audio, rx_video, suite, secret)
//
// Benefici:
//   - elimina la necessità di KID "dummy"
//   - rende esplicita la direzione (TX vs RX)
//   - riduce il rischio di usare metodi sbagliati lato JS
// ---------------------------------------------------------------------------
//
#[wasm_bindgen]
pub struct WasmPeer {
    s_audio: Sender,
    s_video: Sender,
    r_audio: Receiver,
    r_video: Receiver,
}

#[wasm_bindgen]
impl WasmPeer {
    // --------------------------------------------------------
    // COSTRUTTORE BASE (TX/RX CONDIVIDONO GLI STESSI KID)
    // --------------------------------------------------------
    //
    // Questo costruttore imposta:
    //   - Sender audio/video con KID = key_audio/key_video
    //   - Receiver audio/video che accetta gli stessi KID (key_audio/key_video)
    //   - una singola "secret" come chiave simmetrica
    //
    // È comodo quando TX e RX usano la stessa coppia di KID.
    //
    #[wasm_bindgen(constructor)]
    pub fn new(
        key_audio: u32,
        key_video: u32,
        suite: Option<String>,
        secret: Vec<u8>,
    ) -> Result<WasmPeer, JsValue> {
        let suite = parse_suite(suite);

        // Sender (TX)
        let mut s_audio = Sender::with_cipher_suite(key_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let mut s_video = Sender::with_cipher_suite(key_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        // Receiver (RX)
        let mut r_audio = Receiver::with_cipher_suite(suite);
        r_audio
            .set_encryption_key(key_audio as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let mut r_video = Receiver::with_cipher_suite(suite);
        r_video
            .set_encryption_key(key_video as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        Ok(Self {
            s_audio,
            s_video,
            r_audio,
            r_video,
        })
    }

    // --------------------------------------------------------
    // COSTRUTTORE FULL-DUPLEX (KID TX E RX POSSONO ESSERE DIVERSI)
    // --------------------------------------------------------
    //
    // Qui puoi specificare:
    //   - KID per TX (tx_audio/tx_video)
    //   - KID per RX (rx_audio/rx_video)
    //
    // È utile quando i KID usati per cifrare NON coincidono con quelli attesi
    // in ricezione (es. RX per sender remoto).
    //
    #[wasm_bindgen(js_name = "new_full_duplex")]
    pub fn new_full_duplex(
        tx_audio: u32,
        tx_video: u32,
        rx_audio: u32,
        rx_video: u32,
        suite: Option<String>,
        secret: Vec<u8>,
    ) -> Result<WasmPeer, JsValue> {
        let suite = parse_suite(suite);

        // Sender (TX) con KID specifici
        let mut s_audio = Sender::with_cipher_suite(tx_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let mut s_video = Sender::with_cipher_suite(tx_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        // Receiver (RX) con KID specifici
        let mut r_audio = Receiver::with_cipher_suite(suite);
        r_audio
            .set_encryption_key(rx_audio as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let mut r_video = Receiver::with_cipher_suite(suite);
        r_video
            .set_encryption_key(rx_video as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        Ok(Self {
            s_audio,
            s_video,
            r_audio,
            r_video,
        })
    }

    // --------------------------------------------------------
    // CIFRATURA (ENCRYPT) - AUDIO / VIDEO
    // --------------------------------------------------------

    #[wasm_bindgen]
    pub fn encrypt_audio(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let out = self
            .s_audio
            .encrypt_frame(&input)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let packet = out.to_vec();

        // Cattura header TX per debug (se deserializzazione ok)
        if let Ok(hdr) = SframeHeader::deserialize(&packet) {
            capture_header(true, &hdr, &packet);
        }

        Ok(packet)
    }

    #[wasm_bindgen]
    pub fn encrypt_video(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let out = self
            .s_video
            .encrypt_frame(&input)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        let packet = out.to_vec();

        // Cattura header TX per debug (se deserializzazione ok)
        if let Ok(hdr) = SframeHeader::deserialize(&packet) {
            capture_header(true, &hdr, &packet);
        }

        Ok(packet)
    }

    // --------------------------------------------------------
    // DECIFRATURA (DECRYPT) - AUDIO / VIDEO
    // --------------------------------------------------------

    #[wasm_bindgen]
    pub fn decrypt_audio(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        // Cattura header RX per debug (se deserializzazione ok)
        if let Ok(hdr) = SframeHeader::deserialize(&packet) {
            capture_header(false, &hdr, &packet);
        }

        self.r_audio
            .decrypt_frame(&packet)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    #[wasm_bindgen]
    pub fn decrypt_video(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        // Cattura header RX per debug (se deserializzazione ok)
        if let Ok(hdr) = SframeHeader::deserialize(&packet) {
            capture_header(false, &hdr, &packet);
        }

        self.r_video
            .decrypt_frame(&packet)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }
}

// ------------------------------------------------------------
// ISPEZIONE MANUALE DI UN PACCHETTO SFRAME (DEBUG)
// ------------------------------------------------------------
//
// Ritorna una stringa riassuntiva leggibile in JS, utile per log veloci.
//

#[wasm_bindgen]
pub fn sframe_inspect(packet: &[u8]) -> Result<String, JsValue> {
    let hdr = SframeHeader::deserialize(packet)
        .map_err(|e| JsValue::from_str(&format!("Errore parse header SFrame: {e}")))?;

    let header_len = hdr.len();
    let total = packet.len();
    let body = total.saturating_sub(header_len);
    let (ct_len, tag_len) = if body >= 16 { (body - 16, 16) } else { (body, 0) };
    let header_hex = hex::encode(&packet[..header_len]);

    Ok(format!(
        "SFrame[kid={}, ctr={}, aad={}B, ct={}B, tag={}B, header_hex={}]",
        hdr.key_id(),
        hdr.counter(),
        header_len,
        ct_len,
        tag_len,
        header_hex
    ))
}