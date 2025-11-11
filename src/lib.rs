// src/lib.rs
use wasm_bindgen::prelude::*;
use sframe::{CipherSuite, header::SframeHeader};

mod sender;
mod receiver;
use sender::Sender;
use receiver::Receiver;

/// Utility: parsing suite string in JS → enum Rust
fn parse_suite(s: Option<String>) -> CipherSuite {
    match s.as_deref() {
        Some("aes-gcm128-sha256") => CipherSuite::AesGcm128Sha256,
        _ => CipherSuite::AesGcm256Sha512,
    }
}

/// Rappresenta un peer con 4 chiavi distinte (audio/video per TX e RX)
#[wasm_bindgen]
pub struct WasmPeer {
    s_audio: Sender,
    s_video: Sender,
    r_audio: Receiver,
    r_video: Receiver,
}

#[wasm_bindgen]
impl WasmPeer {
    /// Costruttore originale (2 keyId condivisi TX/RX)
    #[wasm_bindgen(constructor)]
    pub fn new(key_audio: u32, key_video: u32, suite: Option<String>, secret: Vec<u8>) -> Result<WasmPeer, JsValue> {
        let suite = parse_suite(suite);

        // Sender
        let mut s_audio = Sender::with_cipher_suite(key_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut s_video = Sender::with_cipher_suite(key_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        // Receiver (usa stessi keyId del sender)
        let mut r_audio = Receiver::with_cipher_suite(suite);
        r_audio
            .set_encryption_key(key_audio as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut r_video = Receiver::with_cipher_suite(suite);
        r_video
            .set_encryption_key(key_video as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        Ok(Self { s_audio, s_video, r_audio, r_video })
    }

    /// 🔄 Nuovo costruttore full-duplex (4 keyId indipendenti)
    ///
    /// # Argomenti
    /// - `tx_audio`, `tx_video`: keyId usati per cifrare i frame locali
    /// - `rx_audio`, `rx_video`: keyId usati per decifrare i frame remoti
    /// - `suite`: opzionale ("aes-gcm128-sha256" o default aes-gcm256-sha512)
    /// - `secret`: materiale condiviso (salt/psk)
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

        // Sender
        let mut s_audio = Sender::with_cipher_suite(tx_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut s_video = Sender::with_cipher_suite(tx_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        // Receiver
        let mut r_audio = Receiver::with_cipher_suite(suite);
        r_audio
            .set_encryption_key(rx_audio as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut r_video = Receiver::with_cipher_suite(suite);
        r_video
            .set_encryption_key(rx_video as u64, &secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

        Ok(Self { s_audio, s_video, r_audio, r_video })
    }

    // --- Encrypt ---
    #[wasm_bindgen]
    pub fn encrypt_audio(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.s_audio
            .encrypt_frame(&input)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    #[wasm_bindgen]
    pub fn encrypt_video(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.s_video
            .encrypt_frame(&input)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    // --- Decrypt ---
    #[wasm_bindgen]
    pub fn decrypt_audio(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.r_audio
            .decrypt_frame(&packet)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    #[wasm_bindgen]
    pub fn decrypt_video(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.r_video
            .decrypt_frame(&packet)
            .map(|b| b.to_vec())
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }
}

/// Analisi compatta di un pacchetto SFrame (solo header, no plaintext)
#[wasm_bindgen]
pub fn sframe_inspect(packet: &[u8]) -> Result<String, JsValue> {
    let hdr = SframeHeader::deserialize(packet)
        .map_err(|e| JsValue::from_str(&format!("SFrame header parse err: {e}")))?;
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
