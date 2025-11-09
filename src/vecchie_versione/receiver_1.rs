use std::collections::HashMap;
use sframe::{
    CipherSuite,
    error::Result,
    frame::{EncryptedFrameView, FrameValidationBox, ReplayAttackProtection},
    header::KeyId,
    key::DecryptionKey,
    ratchet::RatchetingKeyStore,
};

pub struct ReceiverOptions {
    pub cipher_suite: CipherSuite,
    pub frame_validation: Option<FrameValidationBox>,
    pub n_ratchet_bits: Option<u8>,
}

impl Default for ReceiverOptions {
    fn default() -> Self {
        Self {
            cipher_suite: CipherSuite::AesGcm256Sha512,
            frame_validation: Some(Box::new(ReplayAttackProtection::with_tolerance(128))),
            n_ratchet_bits: None,
        }
    }
}

/// Blocca la decifratura lato receiver
pub struct Receiver {
    keys: KeyStore,
    cipher_suite: CipherSuite,
    frame_validation: Option<FrameValidationBox>,
    buffer: Vec<u8>,
}

impl Receiver {
    pub fn decrypt<F>(&mut self, encrypted_frame: F, skip: usize) -> Result<&[u8]>
    where
        F: AsRef<[u8]>,
    {
        let frame = encrypted_frame.as_ref();
        let data = &frame[skip..];
        let meta = &frame[..skip];
        let encrypted = EncryptedFrameView::try_with_meta_data(data, meta)?;

        if let Some(v) = &self.frame_validation {
            encrypted.validate(v)?;
        }
        if let KeyStore::Ratcheting(keys) = &mut self.keys {
            keys.try_ratchet(encrypted.header().key_id())?;
        }
        encrypted.decrypt_into(&self.keys, &mut self.buffer)?;
        Ok(&self.buffer)
    }

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
                    DecryptionKey::derive_from(self.cipher_suite, key_id, key_material)?,
                );
            }
            KeyStore::Ratcheting(store) => {
                store.insert(self.cipher_suite, key_id, key_material)?;
            }
        }
        Ok(())
    }

    pub fn with_cipher_suite(cipher_suite: CipherSuite) -> Self {
        ReceiverOptions { cipher_suite, ..Default::default() }.into()
    }

    pub fn remove_encryption_key<K>(&mut self, key_id: K) -> bool
    where
        K: Into<KeyId>,
    {
        let key_id = key_id.into();
        match &mut self.keys {
            KeyStore::Standard(map) => map.remove(&key_id).is_some(),
            KeyStore::Ratcheting(store) => store.remove(key_id),
        }
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
            frame_validation: opts.frame_validation,
            buffer: Default::default(),
        }
    }
}

impl Default for Receiver {
    fn default() -> Self {
        ReceiverOptions::default().into()
    }
}

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
