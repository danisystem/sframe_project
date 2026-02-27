// src/mls_client.rs
//
// MLS-LITE client locale per WASM.
// Non manteniamo un vero gruppo OpenMLS: usiamo una PSK esterna + room_id + epoch
// per derivare una master key SFrame tramite HKDF.
//
// Questo modulo è pensato per essere usato da lib.rs (esportato verso JS tramite wasm-bindgen).

use hkdf::Hkdf;
use sha2::Sha256;
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};

/// Client MLS "lite" locale dentro il WASM.
///
/// Campi minimi:
/// - identity: nome dell'utente (es. "danilo")
/// - room_id: stanza logica (es. 123456)
/// - epoch: contatore logico (>=1 quando la sessione è attiva)
/// - external_psk: chiave condivisa, mai inviata al server
pub struct MlsClient {
    identity: String,
    room_id: u32,
    epoch: u64,
    external_psk: Option<Vec<u8>>,
}

impl MlsClient {
    /// Crea un nuovo client MLS locale con identity + room_id.
    /// L'epoch parte da 0 (non ancora "attivo").
    pub fn new(identity: String, room_id: u32) -> Self {
        Self {
            identity,
            room_id,
            epoch: 0,
            external_psk: None,
        }
    }

    /// Imposta la PSK condivisa, passata in Base64.
    /// La PSK viene tenuta solo lato client (WASM).
    pub fn set_external_psk_b64(&mut self, psk_b64: String) -> Result<(), String> {
        let psk_b64_trimmed = psk_b64.trim();

        if psk_b64_trimmed.is_empty() {
            return Err("PSK Base64 vuota".to_string());
        }

        let bytes = base64::decode(psk_b64_trimmed)
            .map_err(|e| format!("Errore decode PSK Base64: {e}"))?;

        if bytes.is_empty() {
            return Err("PSK decodificata è vuota".to_string());
        }

        self.external_psk = Some(bytes);
        Ok(())
    }

    /// Imposta direttamente l'epoch (>=1 quando la sessione è attiva).
    pub fn set_epoch(&mut self, epoch: u64) {
        self.epoch = epoch;
    }

    /// Incrementa l'epoch e ritorna il nuovo valore.
    pub fn bump_epoch(&mut self) -> u64 {
        self.epoch = self.epoch.saturating_add(1);
        self.epoch
    }

    /// Ritorna l'epoch corrente.
    pub fn epoch_u64(&self) -> u64 {
        self.epoch
    }

    /// Ritorna true se:
    /// - abbiamo una PSK impostata
    /// - epoch > 0
    pub fn has_group(&self) -> bool {
        self.external_psk.is_some() && self.epoch > 0
    }

    /// Deriva la master key SFrame (32 byte) come HKDF(PSK, info(room_id, epoch)).
    ///
    /// Questa sostituisce il vecchio master_secret del server.
    pub fn export_sframe_master_b64(&self) -> Result<String, String> {
        let psk = self
            .external_psk
            .as_ref()
            .ok_or_else(|| "PSK non impostata (chiama mls_set_external_psk_b64 prima)".to_string())?;

        if self.epoch == 0 {
            return Err("Epoch = 0 (chiama mls_set_epoch / mls_bump_epoch prima)".to_string());
        }

        // Costruiamo l'info per HKDF (puoi cambiare il formato se vuoi):
        // "sframe/master|room:<room_id>|epoch:<epoch>"
        let info = format!("sframe/master|room:{}|epoch:{}", self.room_id, self.epoch);
        let info_bytes = info.as_bytes();

        // HKDF-SHA256
        let hk = Hkdf::<Sha256>::new(None, psk);
        let mut okm = [0u8; 32];
        hk.expand(info_bytes, &mut okm)
            .map_err(|e| format!("HKDF expand failed: {e}"))?;

        // Encode in Base64 (senza padding, ma va bene anche con padding se preferisci)
        let b64 = STANDARD_NO_PAD.encode(okm);

        Ok(b64)
    }

    // (facoltativo) getter di debug se ti serve in futuro
    #[allow(dead_code)]
    pub fn identity(&self) -> &str {
        &self.identity
    }

    #[allow(dead_code)]
    pub fn room_id(&self) -> u32 {
        self.room_id
    }
}
