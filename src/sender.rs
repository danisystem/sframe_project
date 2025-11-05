use sframe::frame::MonotonicCounter;
use sframe::{
    CipherSuite,
    error::{Result, SframeError},
    frame::MediaFrameView,
    header::KeyId,
    key::EncryptionKey,
};

#[derive(Clone, Copy, Debug)]
pub struct SenderOptions {
    pub key_id: KeyId,
    pub cipher_suite: CipherSuite,
    pub max_counter: u64,
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

/// Sender: cifra payload per-frame secondo SFrame.
/// Output: [SFrame header || ciphertext || tag]
pub struct Sender {
    counter: MonotonicCounter,
    key_id: KeyId,
    cipher_suite: CipherSuite,
    enc_key: Option<EncryptionKey>,
    buffer: Vec<u8>,
}

impl Sender {
    /// Crea un Sender con key_id e cipher suite di default.
    pub fn new<K>(key_id: K) -> Sender
    where
        K: Into<KeyId>,
    {
        Self::with_cipher_suite(key_id, CipherSuite::AesGcm256Sha512)
    }

    /// Crea un Sender con cipher suite esplicita.
    pub fn with_cipher_suite<K>(key_id: K, cipher_suite: CipherSuite) -> Sender
    where
        K: Into<KeyId>,
    {
        let key_id = key_id.into();
        Sender {
            counter: MonotonicCounter::default(),
            key_id,
            cipher_suite,
            enc_key: None,
            buffer: Vec::new(),
        }
    }

    /// Setta la chiave di cifratura (derive) a partire da key material.
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

    /// Esegue un ratchet: cambia key_id e imposta nuova chiave derivata.
    pub fn ratchet_encryption_key<K, M>(&mut self, key_id: K, key_material: M) -> Result<()>
    where
        K: Into<KeyId>,
        M: AsRef<[u8]>,
    {
        self.key_id = key_id.into();
        self.set_encryption_key(key_material)
    }

    /// Cifra un singolo payload/frame.
    ///
    /// L'AAD è **solo l'header SFrame** generato dalla libreria.
    /// Ritorna [header||ciphertext||tag] in `self.buffer`.
    pub fn encrypt_frame<F>(&mut self, payload: F) -> Result<&[u8]>
    where
        F: AsRef<[u8]>,
    {
        let enc_key = self
            .enc_key
            .as_ref()
            .ok_or(SframeError::EncryptionFailure)?;

        let data = payload.as_ref();

        // Nessuna meta/AAD esterna: meta = []
        let media_frame = MediaFrameView::with_meta_data(&mut self.counter, data, &[]);

        self.buffer.clear();
        // Riserva payload + overhead header+tag (stima)
        self.buffer.reserve(data.len() + 64);

        media_frame.encrypt_into(enc_key, &mut self.buffer)?;
        Ok(&self.buffer)
    }

    /// Reset opzionale del counter (utile per test).
    pub fn reset_counter(&mut self) {
        self.counter = MonotonicCounter::default();
    }

    /// KeyId corrente (per logging se serve).
    pub fn key_id(&self) -> KeyId {
        self.key_id
    }
}

impl From<SenderOptions> for Sender {
    fn from(opts: SenderOptions) -> Self {
        Sender {
            counter: MonotonicCounter::new(opts.max_counter),
            key_id: opts.key_id,
            cipher_suite: opts.cipher_suite,
            enc_key: None,
            buffer: Vec::new(),
        }
    }
}

impl Default for Sender {
    fn default() -> Self {
        SenderOptions::default().into()
    }
}
