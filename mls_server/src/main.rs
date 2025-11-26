// ─────────────────────────────────────────────────────────────
// MLS SERVER – Single-shot export for SFrame WebApp
// ─────────────────────────────────────────────────────────────

use std::sync::{Arc, Mutex};

use warp::Filter;
use serde::{Serialize, Deserialize};

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

use base64::Engine;

// ─────────────────────────────────────────────────────────────
// STRUCTS
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct MemberEntry {
    index: u32,
    identity: String,
}

#[derive(Debug, Deserialize)]
struct JoinRequest {
    identity: String,
}

#[derive(Debug, Serialize)]
struct JoinResponse {
    epoch: u64,
    group_id: String,
    master_secret: String,
    sender_index: u32,
    roster: Vec<MemberEntry>,
}

#[derive(Clone)]
struct GroupState {
    epoch: u64,
    master_secret: Vec<u8>,
    group_id: Vec<u8>,
    roster: Vec<MemberEntry>,
}

#[derive(Clone)]
struct Groups {
    inner: Arc<Mutex<GroupState>>,
}

impl Default for Groups {
    fn default() -> Self {
        // Provider
        let provider = OpenMlsRustCrypto::default();

        // Ciphersuite
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

        // Credenziale server
        let cred = BasicCredential::new(b"server".to_vec());
        let sig = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .expect("signature keypair");

        let credential_with_key = CredentialWithKey {
            credential: cred.into(),
            signature_key: sig.public().into(),
        };

        // Config
        let config = MlsGroupCreateConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();

        // Crea gruppo
        let mut group = MlsGroup::new(
            &provider,
            &sig,
            &config,
            credential_with_key,
        )
        .expect("group create");

        // Estrai master secret
        let master = group
            .export_secret(provider.crypto(), "SFRAME_MASTER", &[], 32)
            .expect("export master");

        let epoch = group.epoch().as_u64(); // FIX
        let gid = group.group_id().to_vec();

        let roster = vec![
            MemberEntry {
                index: 0,
                identity: "server".to_owned(),
            }
        ];

        Groups {
            inner: Arc::new(Mutex::new(GroupState {
                epoch,
                master_secret: master,
                group_id: gid,
                roster,
            })),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────

async fn handle_join(
    req: JoinRequest,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {

    let mut gs = groups.inner.lock().unwrap();

    let new_idx = gs.roster.len() as u32;

    gs.roster.push(MemberEntry {
        index: new_idx,
        identity: req.identity.clone(),
    });

    // master → base64
    let master_b64 =
        base64::engine::general_purpose::STANDARD.encode(&gs.master_secret);

    // group id → hex
    let gid_hex = gs.group_id.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    let resp = JoinResponse {
        epoch: gs.epoch,
        group_id: gid_hex,
        master_secret: master_b64,
        sender_index: new_idx,
        roster: gs.roster.clone(),
    };

    Ok(warp::reply::json(&resp))
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let groups = Groups::default();

    let join_route = warp::path!("mls" / "join")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_groups(groups))
        .and_then(handle_join);

    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["Content-Type"])
        .allow_methods(vec!["POST"]);

    let routes = join_route.with(cors);

    println!("MLS server running on http://127.0.0.1:3000");
    warp::serve(routes).run(([127, 0, 0, 1], 3000)).await;
}

fn with_groups(
    groups: Groups,
) -> impl Filter<Extract = (Groups,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || groups.clone())
}
