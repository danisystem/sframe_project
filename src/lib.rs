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
// HEADER DEBUG STRUCT (JSON-friendly verso JS)
// ------------------------------------------------------------

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

// Ultimo header TX/RX catturato (unsafe ok in wasm single-thread)
static mut LAST_TX_HDR: Option<SframeHeaderDebug> = None;
static mut LAST_RX_HDR: Option<SframeHeaderDebug> = None;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

fn parse_suite(s: Option<String>) -> CipherSuite {
    match s.as_deref() {
        Some("aes-gcm128-sha256") => CipherSuite::AesGcm128Sha256,
        _ => CipherSuite::AesGcm256Sha512,
    }
}

fn capture_header(dir_tx: bool, hdr: &SframeHeader, packet: &[u8]) {
    let header_len = hdr.len();
    let total = packet.len();
    let body = total.saturating_sub(header_len);
    let (ct_len, tag_len) = if body >= 16 { (body - 16, 16) } else { (body, 0) };

    let header_hex = hex::encode(&packet[..header_len]);

    let dbg = SframeHeaderDebug {
        kid: hdr.key_id(),
        ctr: hdr.counter(),
        header_len,
        aad_len: header_len,
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
// WASM EXPORTS: retrieve last headers (usa serde-wasm-bindgen)
// ------------------------------------------------------------

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
// PEER
// ------------------------------------------------------------

#[wasm_bindgen]
pub struct WasmPeer {
    s_audio: Sender,
    s_video: Sender,
    r_audio: Receiver,
    r_video: Receiver,
}

#[wasm_bindgen]
impl WasmPeer {
    // Costruttore base (TX/RX keyId condivisi)
    #[wasm_bindgen(constructor)]
    pub fn new(
        key_audio: u32,
        key_video: u32,
        suite: Option<String>,
        secret: Vec<u8>,
    ) -> Result<WasmPeer, JsValue> {
        let suite = parse_suite(suite);

        let mut s_audio = Sender::with_cipher_suite(key_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut s_video = Sender::with_cipher_suite(key_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

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

    // Costruttore full-duplex (4 keyId indipendenti)
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

        let mut s_audio = Sender::with_cipher_suite(tx_audio as u64, suite);
        s_audio
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut s_video = Sender::with_cipher_suite(tx_video as u64, suite);
        s_video
            .set_encryption_key(&secret)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;

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
    // ENCRYPT
    // --------------------------------------------------------

    #[wasm_bindgen]
    pub fn encrypt_audio(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        let out = self
            .s_audio
            .encrypt_frame(&input)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let packet = out.to_vec();

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

        if let Ok(hdr) = SframeHeader::deserialize(&packet) {
            capture_header(true, &hdr, &packet);
        }

        Ok(packet)
    }

    // --------------------------------------------------------
    // DECRYPT
    // --------------------------------------------------------

    #[wasm_bindgen]
    pub fn decrypt_audio(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
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
// Ispezione manuale (resta com’era)
// ------------------------------------------------------------

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
