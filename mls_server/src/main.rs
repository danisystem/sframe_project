// ─────────────────────────────────────────────────────────────
// MLS SERVER – Export per SFrame WebApp + Roster endpoint
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

#[derive(Debug, Serialize)]
struct RosterResponse {
    epoch: u64,
    group_id: String,
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
        let ciphersuite =
            Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

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

        // Crea gruppo con un solo membro (server)
        let group = MlsGroup::new(
            &provider,
            &sig,
            &config,
            credential_with_key,
        )
        .expect("group create");

        // Estrai master secret che useremo come base per SFrame
        let master = group
            .export_secret(provider.crypto(), "SFRAME_MASTER", &[], 32)
            .expect("export master");

        let epoch = group.epoch().as_u64();
        let gid = group.group_id().to_vec();

        // Roster iniziale: solo il server, index = 0
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
// HANDLER JOIN
// ─────────────────────────────────────────────────────────────

async fn handle_join(
    req: JoinRequest,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {

    let mut gs = groups.inner.lock().unwrap();

    // Se l'identity esiste già in roster, riusa lo stesso index
    if let Some(existing) = gs.roster.iter().find(|m| m.identity == req.identity) {
        let master_b64 =
            base64::engine::general_purpose::STANDARD.encode(&gs.master_secret);
        let gid_hex = gs.group_id
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        let resp = JoinResponse {
            epoch: gs.epoch,
            group_id: gid_hex,
            master_secret: master_b64,
            sender_index: existing.index,
            roster: gs.roster.clone(),
        };

        println!(
            "[MLS] re-join identity={} → sender_index={}",
            existing.identity, existing.index
        );
        return Ok(warp::reply::json(&resp));
    }

    // Altrimenti è una nuova identity → assegna nuovo index
    let new_idx = gs.roster.len() as u32;

    gs.roster.push(MemberEntry {
        index: new_idx,
        identity: req.identity.clone(),
    });

    let master_b64 =
        base64::engine::general_purpose::STANDARD.encode(&gs.master_secret);

    let gid_hex = gs.group_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let resp = JoinResponse {
        epoch: gs.epoch,
        group_id: gid_hex,
        master_secret: master_b64,
        sender_index: new_idx,
        roster: gs.roster.clone(),
    };

    println!(
        "[MLS] new join identity={} → sender_index={}",
        req.identity, new_idx
    );

    Ok(warp::reply::json(&resp))
}

// ─────────────────────────────────────────────────────────────
// HANDLER ROSTER (GET /mls/roster)
// ─────────────────────────────────────────────────────────────

async fn handle_roster(
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {

    let gs = groups.inner.lock().unwrap();

    let gid_hex = gs.group_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let resp = RosterResponse {
        epoch: gs.epoch,
        group_id: gid_hex,
        roster: gs.roster.clone(),
    };

    println!(
        "[MLS] roster requested → epoch={}, members={}",
        gs.epoch,
        gs.roster.len()
    );

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
        .and(with_groups(groups.clone()))
        .and_then(handle_join);

    let roster_route = warp::path!("mls" / "roster")
        .and(warp::get())
        .and(with_groups(groups.clone()))
        .and_then(handle_roster);

    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["Content-Type"])
        .allow_methods(vec!["GET", "POST"]);

    let routes = join_route
        .or(roster_route)
        .with(cors);

    println!("MLS server running on http://0.0.0.0:3000");
    warp::serve(routes).run(([0, 0, 0, 0], 3000)).await;
}

fn with_groups(
    groups: Groups,
) -> impl Filter<Extract = (Groups,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || groups.clone())
}
