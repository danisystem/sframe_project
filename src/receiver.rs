use std::collections::HashMap;

use sframe::{
    CipherSuite,
    error::Result,
    frame::EncryptedFrameView,
    header::KeyId,
    key::DecryptionKey,
    ratchet::RatchetingKeyStore,
};

pub struct ReceiverOptions {
    pub cipher_suite: CipherSuite,
    pub n_ratchet_bits: Option<u8>,
}

impl Default for ReceiverOptions {
    fn default() -> Self {
        Self {
            cipher_suite: CipherSuite::AesGcm256Sha512,
            n_ratchet_bits: None,
        }
    }
}

/// Receiver: gestisce la decifratura lato ricezione.
/// Non esegue frame validation esplicita (evita problemi legati a Send).
pub struct Receiver {
    keys: KeyStore,
    cipher_suite: CipherSuite,
    buffer: Vec<u8>,
}

impl Receiver {
    /// Decifra un frame ricevuto nel formato:
    /// [SFrame header || ciphertext || tag]
    ///
    /// Restituisce il payload in chiaro.
    pub fn decrypt_frame<F>(&mut self, packet: F) -> Result<&[u8]>
    where
        F: AsRef<[u8]>,
    {
        let data = packet.as_ref();

        let encrypted = EncryptedFrameView::try_from(data)?;

        // Se è attivo il ratcheting, tenta l’avanzamento della chiave
        if let KeyStore::Ratcheting(keys) = &mut self.keys {
            keys.try_ratchet(encrypted.header().key_id())?;
        }

        encrypted.decrypt_into(&self.keys, &mut self.buffer)?;

        Ok(&self.buffer)
    }

    /// Inserisce/deriva una chiave di decifratura per un determinato KeyId.
    pub fn set_encryption_key<K, M>(&mut self, key_id: K, key_material: M) -> Result<()>
    where
        K: Into<KeyId>,
        M: AsRef<[u8]>,
    {
        let key_id = key_id.into();

        match &mut self.keys {
            KeyStore::Standard(map) => {
                map.insert(
                    key_id,
                    DecryptionKey::derive_from(
                        self.cipher_suite,
                        key_id,
                        key_material,
                    )?,
                );
            }
            KeyStore::Ratcheting(store) => {
                store.insert(self.cipher_suite, key_id, key_material)?;
            }
        }

        Ok(())
    }

    /// Crea un Receiver specificando la cipher suite.
    pub fn with_cipher_suite(cipher_suite: CipherSuite) -> Self {
        ReceiverOptions {
            cipher_suite,
            ..Default::default()
        }
        .into()
    }
}

impl From<ReceiverOptions> for Receiver {
    fn from(opts: ReceiverOptions) -> Self {
        let keys = match opts.n_ratchet_bits {
            Some(bits) => KeyStore::Ratcheting(RatchetingKeyStore::new(bits)),
            None => KeyStore::default(),
        };

        Self {
            keys,
            cipher_suite: opts.cipher_suite,
            buffer: Default::default(),
        }
    }
}

impl Default for Receiver {
    fn default() -> Self {
        ReceiverOptions::default().into()
    }
}

/// Gestione delle chiavi lato receiver:
/// - Standard: mappa KeyId -> DecryptionKey
/// - Ratcheting: store con avanzamento automatico
enum KeyStore {
    Standard(HashMap<KeyId, DecryptionKey>),
    Ratcheting(RatchetingKeyStore),
}

impl Default for KeyStore {
    fn default() -> Self {
        KeyStore::Standard(HashMap::new())
    }
}

impl sframe::key::KeyStore for KeyStore {
    fn get_key<K>(&self, key_id: K) -> Option<&DecryptionKey>
    where
        K: Into<KeyId>,
    {
        let key_id = key_id.into();

        match self {
            KeyStore::Standard(map) => map.get(&key_id),
            KeyStore::Ratcheting(store) => store.get_key(key_id),
        }
    }
}