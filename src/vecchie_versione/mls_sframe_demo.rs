use std::error::Error as StdError;
use std::fmt;

use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;

use sframe::{
    CipherSuite as SframeCipherSuite,
    key::{EncryptionKey, DecryptionKey},
    mls::{MlsExporter, MlsKeyId, MlsKeyIdBitRange},
};

fn main() {
    if let Err(e) = run() {
        eprintln!("[demo] Errore nella demo MLS+SFrame: {e:?}");
    }
}

fn run() -> Result<(), Box<dyn StdError>> {
    /* ───────────── 1) Setup MLS (provider + ciphersuite) ───────────── */

    let provider = OpenMlsRustCrypto::default();
    let mls_ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    /* ───────────── 2) Credenziali + chiavi di firma per Alice e Bob ───────────── */

    let (alice_cred_with_key, alice_signer) = generate_credential_with_key(
        b"alice".to_vec(),
        CredentialType::Basic,
        mls_ciphersuite.signature_algorithm(),
    )?;

    let (bob_cred_with_key, bob_signer) = generate_credential_with_key(
        b"bob".to_vec(),
        CredentialType::Basic,
        mls_ciphersuite.signature_algorithm(),
    )?;

    /* Helper per creare il KeyPackage di Bob (serve ad Alice per invitarlo) */
    let bob_key_package = KeyPackage::builder()
        .build(
            mls_ciphersuite,
            &provider,
            &bob_signer,
            bob_cred_with_key,
        )?;

    /* ───────────── 3) Crea gruppo MLS con solo Alice (epoch 0) ───────────── */

    let mut alice_group = MlsGroup::new(
        &provider,
        &alice_signer,
        &MlsGroupCreateConfig::default(),
        alice_cred_with_key,
    )?;

    let epoch0 = alice_group.epoch().as_u64();
    println!("[MLS] Gruppo creato; epoch iniziale = {:?}", alice_group.epoch());

    /* ───────────── 4) Deriviamo chiavi SFrame per Alice @ epoch 0 ───────────── */

    let (alice_enc_e0, alice_dec_e0) =
        derive_sframe_keys("Alice @ epoch0", &alice_group, &provider)?;

    println!(
        "[SFrame] Alice epoch0 → ENC key_id = {:?}, suite = {:?}",
        alice_enc_e0.key_id(),
        alice_enc_e0.cipher_suite(),
    );
    println!(
        "[SFrame] Alice epoch0 → DEC key_id = {:?}, suite = {:?}",
        alice_dec_e0.key_id(),
        alice_dec_e0.cipher_suite(),
    );

    /* ───────────── 5) Alice aggiunge Bob → nuovo commit → nuova epoch ───────────── */

    println!();
    println!("[MLS] Alice aggiunge Bob al gruppo...");

    let (_commit_msg, _welcome_opt, _group_info) = alice_group.add_members(
        &provider,
        &alice_signer,
        core::slice::from_ref(bob_key_package.key_package()),
    )?;

    // Applichiamo il commit pendente: qui l'epoch deve cambiare (0 → 1).
    alice_group.merge_pending_commit(&provider)?;

    let epoch1 = alice_group.epoch().as_u64();
    println!("[MLS] Dopo add_members+merge → nuova epoch = {:?}", alice_group.epoch());

    /* ───────────── 6) Deriviamo di nuovo chiavi SFrame @ epoch 1 ───────────── */

    let (alice_enc_e1, alice_dec_e1) =
        derive_sframe_keys("Alice @ epoch1", &alice_group, &provider)?;

    println!(
        "[SFrame] Alice epoch1 → ENC key_id = {:?}, suite = {:?}",
        alice_enc_e1.key_id(),
        alice_enc_e1.cipher_suite(),
    );
    println!(
        "[SFrame] Alice epoch1 → DEC key_id = {:?}, suite = {:?}",
        alice_dec_e1.key_id(),
        alice_dec_e1.cipher_suite(),
    );

    /* ───────────── 7) Riepilogo: epoch e KID SFrame ───────────── */

    println!();
    println!("【 RIEPILOGO ] epoch0 = {epoch0}, epoch1 = {epoch1}");
    println!(
        "【 RIEPILOGO ] KID ENC Alice: epoch0 = {:?}, epoch1 = {:?}",
        alice_enc_e0.key_id(),
        alice_enc_e1.key_id()
    );
    println!(
        "【 RIEPILOGO ] KID DEC Alice: epoch0 = {:?}, epoch1 = {:?}",
        alice_dec_e0.key_id(),
        alice_dec_e1.key_id()
    );

    println!();
    println!("✓ Demo OK → MLS add_members+commit → epoch++ → nuove chiavi SFrame (nuovi KID)");
    println!();

    Ok(())
}

/* ───────────────────────── Helpers SFrame+MLS ───────────────────────── */

fn derive_sframe_keys(
    label: &str,
    mls_group: &MlsGroup,
    provider: &impl OpenMlsProvider,
) -> Result<(EncryptionKey, DecryptionKey), Box<dyn StdError>> {
    println!();
    println!("[+] Derivo chiavi SFrame → {label}");

    let exporter = GroupExporter {
        group: mls_group,
        provider,
    };

    let sframe_suite = SframeCipherSuite::AesGcm256Sha512;

    // epoch MLS corrente
    let epoch = mls_group.epoch().as_u64();
    // indice foglia di Alice
    let member_index = mls_group.own_leaf_index().u32() as u64;

    // Usiamo 8 bit per epoch e 8 per member_index (come prima).
    let bit_range = MlsKeyIdBitRange::new(8, 8);

    // context_id = 0 (un solo stream per la demo)
    let mls_key_id = MlsKeyId::new(0u64, epoch, member_index, bit_range);

    println!("[SFrame] MlsKeyId = {:?}", mls_key_id);

    let enc_key = EncryptionKey::derive_from_mls(sframe_suite, &exporter, mls_key_id)?;
    let dec_key = DecryptionKey::derive_from_mls(sframe_suite, &exporter, mls_key_id)?;

    Ok((enc_key, dec_key))
}

/* ───────────────────────── Helpers MLS ───────────────────────── */

fn generate_credential_with_key(
    identity: Vec<u8>,
    _credential_type: CredentialType,
    signature_algorithm: SignatureScheme,
) -> Result<(CredentialWithKey, SignatureKeyPair), Box<dyn StdError>> {
    // Credenziale "base" (BasicCredential)
    let credential = BasicCredential::new(identity);

    // Coppia di chiavi di firma (Ed25519 per questo ciphersuite)
    let signature_keys =
        SignatureKeyPair::new(signature_algorithm)
            .expect("Errore nella generazione della chiave di firma");

    // CredentialWithKey = (identità + chiave pubblica di firma)
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signature_keys.public().into(),
    };

    Ok((credential_with_key, signature_keys))
}

/* ───────────────────── Exporter MLS → SFrame ───────────────────── */

#[derive(Debug)]
struct ExporterError;

impl fmt::Display for ExporterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MLS export_secret failed")
    }
}

impl StdError for ExporterError {}

struct GroupExporter<'a, P: OpenMlsProvider> {
    group: &'a MlsGroup,
    provider: &'a P,
}

impl<'a, P: OpenMlsProvider> MlsExporter for GroupExporter<'a, P> {
    type BaseKey = Vec<u8>;
    type Error = ExporterError;

    fn export_secret(
        &self,
        label: &str,
        context: &[u8],
        key_length: usize,
    ) -> Result<Self::BaseKey, Self::Error> {
        self.group
            .export_secret(self.provider.crypto(), label, context, key_length)
            .map_err(|_| ExporterError)
    }
}
