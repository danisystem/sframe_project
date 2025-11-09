use wasm_bindgen::prelude::*;
use sframe::CipherSuite;

mod sender;
mod receiver;
use sender::Sender;
use receiver::{Receiver, ReceiverOptions};

#[wasm_bindgen]
pub struct WasmPeer {
    s_audio: Sender,
    s_video: Sender,
    r_audio: Receiver,
    r_video: Receiver,
}

fn parse_suite(s: Option<String>) -> CipherSuite {
    match s.as_deref() {
        Some("aes-gcm128-sha256") => CipherSuite::AesGcm128Sha256,
        _ => CipherSuite::AesGcm256Sha512,
    }
}

#[wasm_bindgen]
impl WasmPeer {
    #[wasm_bindgen(constructor)]
    pub fn new(key_audio: u32, key_video: u32, suite: Option<String>, secret: Vec<u8>) -> Result<WasmPeer, JsValue> {
        let suite = parse_suite(suite);

        // Sender
        let mut s_audio = Sender::with_cipher_suite(key_audio as u64, suite);
        s_audio.set_encryption_key(&secret).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut s_video = Sender::with_cipher_suite(key_video as u64, suite);
        s_video.set_encryption_key(&secret).map_err(|e| JsValue::from_str(&format!("{e}")))?;

        // Receiver
        let mut r_audio = Receiver::with_cipher_suite(suite);
        r_audio.set_encryption_key(key_audio as u64, &secret).map_err(|e| JsValue::from_str(&format!("{e}")))?;
        let mut r_video = Receiver::with_cipher_suite(suite);
        r_video.set_encryption_key(key_video as u64, &secret).map_err(|e| JsValue::from_str(&format!("{e}")))?;

        Ok(Self { s_audio, s_video, r_audio, r_video })
    }

    pub fn encrypt_audio(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.s_audio.encrypt_frame(&input).map(|b| b.to_vec()).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    pub fn encrypt_video(&mut self, input: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.s_video.encrypt_frame(&input).map(|b| b.to_vec()).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    pub fn decrypt_audio(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.r_audio.decrypt_frame(&packet).map(|b| b.to_vec()).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
    pub fn decrypt_video(&mut self, packet: Vec<u8>) -> Result<Vec<u8>, JsValue> {
        self.r_video.decrypt_frame(&packet).map(|b| b.to_vec()).map_err(|e| JsValue::from_str(&format!("{e}")))
    }
}
