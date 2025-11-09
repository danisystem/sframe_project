use sframe::frame::MonotonicCounter;
use sframe::{
    CipherSuite,
    error::{Result, SframeError},
    frame::MediaFrameView,
    header::{Counter, KeyId},
    key::EncryptionKey,
};

#[derive(Clone, Copy, Debug)]
pub struct SenderOptions {
    pub key_id: KeyId,
    pub cipher_suite: CipherSuite,
    pub max_counter: Counter,
}

impl Default for SenderOptions {
    fn default() -> Self {
        Self {
            key_id: 0,
            cipher_suite: CipherSuite::AesGcm256Sha512,
            max_counter: u64::MAX,
        }
    }
}

/// Modella il blocco di cifratura del sender
pub struct Sender {
    counter: MonotonicCounter,
    key_id: KeyId,
    cipher_suite: CipherSuite,
    enc_key: Option<EncryptionKey>,
    buffer: Vec<u8>,
}

impl Sender {
    pub fn new<K>(key_id: K) -> Sender
    where
        K: Into<KeyId>,
    {
        Self::with_cipher_suite(key_id, CipherSuite::AesGcm256Sha512)
    }

    pub fn with_cipher_suite<K>(key_id: K, cipher_suite: CipherSuite) -> Sender
    where
        K: Into<KeyId>,
    {
        let key_id = key_id.into();
        Sender {
            counter: Default::default(),
            key_id,
            cipher_suite,
            enc_key: None,
            buffer: Default::default(),
        }
    }

    /// Cifra un frame: i primi `skip` byte restano in chiaro (AAD).
    pub fn encrypt<F>(&mut self, unencrypted_frame: F, skip: usize) -> Result<&[u8]>
    where
        F: AsRef<[u8]>,
    {
        if let Some(enc_key) = &self.enc_key {
            let frame = unencrypted_frame.as_ref();
            let payload = &frame[skip..];
            let meta_data = &frame[..skip];
            let media_frame = MediaFrameView::with_meta_data(&mut self.counter, payload, meta_data);
            media_frame.encrypt_into(enc_key, &mut self.buffer)?;
            Ok(&self.buffer)
        } else {
            Err(SframeError::EncryptionFailure)
        }
    }

    /// Crea la chiave di cifratura a partire dal materiale fornito.
    pub fn set_encryption_key<M>(&mut self, key_material: M) -> Result<()>
    where
        M: AsRef<[u8]>,
    {
        self.enc_key = Some(EncryptionKey::derive_from(
            self.cipher_suite,
            self.key_id,
            key_material,
        )?);
        Ok(())
    }

    /// Esegue un ratchet: aggiorna key_id e rigenera la chiave.
    pub fn ratchet_encryption_key<K, M>(&mut self, key_id: K, key_material: M) -> Result<()>
    where
        K: Into<KeyId>,
        M: AsRef<[u8]>,
    {
        self.key_id = key_id.into();
        self.set_encryption_key(key_material)
    }
}

impl From<SenderOptions> for Sender {
    fn from(options: SenderOptions) -> Self {
        Self {
            key_id: options.key_id,
            cipher_suite: options.cipher_suite,
            enc_key: None,
            counter: MonotonicCounter::new(options.max_counter),
            buffer: Default::default(),
        }
    }
}

impl Default for Sender {
    fn default() -> Self {
        SenderOptions::default().into()
    }
}
