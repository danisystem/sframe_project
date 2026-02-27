// src/mls_client.rs
#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;
use std::sync::{Arc, Mutex};

// Esportiamo la struct verso Javascript
#[wasm_bindgen]
pub struct WasmMlsClient {
    identity: String,
    // OpenMLS richiede un "provider" crittografico per gestire lo stato e le chiavi in memoria
    provider: OpenMlsRustCrypto,
    credential_with_key: CredentialWithKey,
    signature_keypair: SignatureKeyPair,
}

#[wasm_bindgen]
impl WasmMlsClient {
    /// Inizializza un nuovo client MLS in memoria per questo utente
    #[wasm_bindgen(constructor)]
    pub fn new(identity: &str) -> Result<WasmMlsClient, JsValue> {
        let provider = OpenMlsRustCrypto::default();
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        // 1. Creiamo la credenziale (l'identità dell'utente)
        let cred = BasicCredential::new(identity.as_bytes().to_vec());
        
        // 2. Generiamo la coppia di chiavi asimmetriche (Privata/Pubblica) salvate in memoria
        let sig_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .map_err(|_| JsValue::from_str("Errore generazione chiavi MLS"))?;

        let credential_with_key = CredentialWithKey {
            credential: cred.into(),
            signature_key: sig_keypair.public().into(),
        };

        Ok(Self {
            identity: identity.to_string(),
            provider,
            credential_with_key,
            signature_keypair: sig_keypair,
        })
    }

    /// Step 1: Genera il KeyPackage (la chiave pubblica da mandare al server)
    #[wasm_bindgen]
    pub fn generate_key_package(&self) -> Result<Vec<u8>, JsValue> {
        // ... (qui implementeremo la generazione del KeyPackage OpenMLS) ...
        Ok(vec![]) // Placeholder per ora
    }

    /// Step 2 (Creatore): Crea il gruppo e restituisce il master_secret
    #[wasm_bindgen]
    pub fn create_group(&mut self) -> Result<Vec<u8>, JsValue> {
        // ... (qui creeremo l'MlsGroup ed estrarremo l'export_secret) ...
        Ok(vec![]) // Placeholder
    }

    /// Step 3 (Creatore): Aggiunge un KeyPackage e crea un Welcome message
    #[wasm_bindgen]
    pub fn add_member(&mut self, key_package_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        // ... (processa la chiave dell'altro utente e cifra il segreto per lui) ...
        Ok(vec![]) // Placeholder
    }

    /// Step 4 (Joiner): Usa il Welcome message per entrare nel gruppo e ottenere il master_secret
    #[wasm_bindgen]
    pub fn process_welcome(&mut self, welcome_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        // ... (usa la chiave privata locale per decifrare il welcome) ...
        Ok(vec![]) // Placeholder
    }
}