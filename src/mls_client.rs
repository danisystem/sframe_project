// src/mls_client.rs
#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;
use tls_codec::{Deserialize, Serialize};

use openmls_traits::OpenMlsProvider;
use openmls_traits::storage::StorageProvider;

#[wasm_bindgen]
pub struct WasmMlsClient {
    identity: String,
    provider: OpenMlsRustCrypto,
    signature_keypair: SignatureKeyPair,
    group: Option<MlsGroup>,
}

#[wasm_bindgen]
impl WasmMlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &str) -> Result<WasmMlsClient, JsValue> {
        let provider = OpenMlsRustCrypto::default();
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .map_err(|_| JsValue::from_str("Errore chiavi"))?;
        
        Ok(Self {
            identity: identity.to_string(),
            provider,
            signature_keypair,
            group: None,
        })
    }

    #[wasm_bindgen]
    pub fn generate_key_package(&mut self) -> Result<Vec<u8>, JsValue> {
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        let credential = BasicCredential::new(self.identity.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: self.signature_keypair.public().into(),
        };

        let kp_bundle = KeyPackage::builder()
            .build(ciphersuite, &self.provider, &self.signature_keypair, credential_with_key)
            .map_err(|_| JsValue::from_str("Errore builder KP"))?;

        let kp = kp_bundle.key_package();
        let kp_ref = kp.hash_ref(self.provider.crypto()).unwrap();
        
        self.provider.storage().write_key_package(&kp_ref, &kp_bundle).unwrap();

        web_sys::console::log_1(&"[RUST-WASM] KeyPackage generato e salvato nel Provider!".into());
        kp.tls_serialize_detached().map_err(|_| JsValue::from_str("Errore ser"))
    }

    #[wasm_bindgen]
    pub fn process_welcome(&mut self, welcome_bytes: &[u8]) -> Result<(), JsValue> {
        let welcome = Welcome::tls_deserialize(&mut &welcome_bytes[..])
            .map_err(|_| JsValue::from_str("Welcome corrotto"))?;

        let join_config = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();

        web_sys::console::log_1(&"[RUST-WASM] Tento di decifrare il Welcome...".into());

        let staged_welcome = StagedWelcome::new_from_welcome(&self.provider, &join_config, welcome, None)
            .map_err(|e| JsValue::from_str(&format!("Errore StagedWelcome: {:?}", e)))?;

        let group = staged_welcome.into_group(&self.provider)
            .map_err(|e| JsValue::from_str(&format!("Errore IntoGroup: {:?}", e)))?;

        self.group = Some(group);
        web_sys::console::log_1(&"[RUST-WASM] Welcome APERTO CON SUCCESSO!".into());
        Ok(())
    }

    #[wasm_bindgen]
    pub fn create_group(&mut self) -> Result<(), JsValue> {
        let config = MlsGroupCreateConfig::builder().use_ratchet_tree_extension(true).build();
        let credential = BasicCredential::new(self.identity.as_bytes().to_vec());
        let credential_with_key = CredentialWithKey {
            credential: credential.into(),
            signature_key: self.signature_keypair.public().into(),
        };

        let group = MlsGroup::new(&self.provider, &self.signature_keypair, &config, credential_with_key).unwrap();
        self.group = Some(group);
        Ok(())
    }

    #[wasm_bindgen]
    pub fn add_member(&mut self, kp_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let group = self.group.as_mut().unwrap();
        let kp = KeyPackageIn::tls_deserialize(&mut &kp_bytes[..]).unwrap()
            .validate(self.provider.crypto(), ProtocolVersion::Mls10).unwrap();
        
        let (_commit, welcome, _) = group.add_members(&self.provider, &self.signature_keypair, &[kp]).unwrap();
        group.merge_pending_commit(&self.provider).unwrap();
        welcome.tls_serialize_detached().map_err(|_| JsValue::from_str("Errore ser"))
    }

    #[wasm_bindgen]
    pub fn get_master_secret(&self) -> Result<Vec<u8>, JsValue> {
        let group = self.group.as_ref().unwrap();
        let secret = group.export_secret(self.provider.crypto(), "SFRAME_MASTER", &[], 32).unwrap();
        Ok(secret)
    }
}