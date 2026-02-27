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

/// Sender: cifra un payload per-frame secondo lo standard SFrame.
/// Output generato: [SFrame header || ciphertext || tag]
pub struct Sender {
    counter: MonotonicCounter,
    key_id: KeyId,
    cipher_suite: CipherSuite,
    enc_key: Option<EncryptionKey>,
    buffer: Vec<u8>,
}

impl Sender {
    /// Crea un nuovo Sender con key_id e cipher suite di default (AES-GCM-256 + SHA-512).
    pub fn new<K>(key_id: K) -> Sender
    where
        K: Into<KeyId>,
    {
        Self::with_cipher_suite(key_id, CipherSuite::AesGcm256Sha512)
    }

    /// Crea un Sender specificando esplicitamente la cipher suite.
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

    /// Imposta la chiave di cifratura derivandola dal key material fornito.
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

    /// Esegue un ratchet:
    /// - aggiorna il key_id
    /// - deriva e imposta una nuova chiave di cifratura
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
    /// L'AAD utilizzata è esclusivamente l'header SFrame generato internamente.
    /// Restituisce il buffer contenente [header || ciphertext || tag].
    pub fn encrypt_frame<F>(&mut self, payload: F) -> Result<&[u8]>
    where
        F: AsRef<[u8]>,
    {
        let enc_key = self
            .enc_key
            .as_ref()
            .ok_or(SframeError::EncryptionFailure)?;

        let data = payload.as_ref();

        // Nessuna AAD esterna: meta = []
        let media_frame = MediaFrameView::with_meta_data(&mut self.counter, data, &[]);

        self.buffer.clear();

        // Riserva spazio: payload + overhead stimato (header + tag)
        self.buffer.reserve(data.len() + 64);

        media_frame.encrypt_into(enc_key, &mut self.buffer)?;

        Ok(&self.buffer)
    }

    /// Reset opzionale del counter (utile in fase di test).
    pub fn reset_counter(&mut self) {
        self.counter = MonotonicCounter::default();
    }

    /// Restituisce il KeyId corrente (utile per logging/debug).
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