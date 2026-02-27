// ─────────────────────────────────────────────────────────────
// MLS SERVER – Export per SFrame WebApp + Roster endpoint (multi-room)
// ─────────────────────────────────────────────────────────────

use std::collections::HashMap;
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
    room_id: u32,
}

#[derive(Debug, Serialize)]
struct JoinResponse {
    epoch: u64,
    group_id: String,
    room_id: u32,
    master_secret: String,
    sender_index: u32,
    roster: Vec<MemberEntry>,
}

#[derive(Debug, Deserialize)]
struct RosterQuery {
    room_id: u32,
}

#[derive(Debug, Serialize)]
struct RosterResponse {
    epoch: u64,
    group_id: String,
    room_id: u32,
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
    // room_id → stato MLS per quella stanza
    inner: Arc<Mutex<HashMap<u32, GroupState>>>,
}

impl Groups {
    fn new() -> Self {
        Groups {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// helper: crea un nuovo gruppo MLS e ne estrae master_secret/epoch/group_id
fn make_group_state() -> GroupState {
    let provider = OpenMlsRustCrypto::default();
    let ciphersuite =
        Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    let cred = BasicCredential::new(b"server".to_vec());
    let sig = SignatureKeyPair::new(ciphersuite.signature_algorithm())
        .expect("signature keypair");

    let credential_with_key = CredentialWithKey {
        credential: cred.into(),
        signature_key: sig.public().into(),
    };

    let config = MlsGroupCreateConfig::builder()
        .use_ratchet_tree_extension(true)
        .build();

    let group = MlsGroup::new(
        &provider,
        &sig,
        &config,
        credential_with_key,
    )
    .expect("group create");

    let master = group
        .export_secret(provider.crypto(), "SFRAME_MASTER", &[], 32)
        .expect("export master");

    let epoch = group.epoch().as_u64();
    let gid = group.group_id().to_vec();

    let roster = vec![
        MemberEntry {
            index: 0,
            identity: "server".to_owned(),
        }
    ];

    GroupState {
        epoch,
        master_secret: master,
        group_id: gid,
        roster,
    }
}

// ─────────────────────────────────────────────────────────────
// HANDLER JOIN (POST /mls/join)
// ─────────────────────────────────────────────────────────────

async fn handle_join(
    req: JoinRequest,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {
    let JoinRequest { identity, room_id } = req;

    let mut map = groups.inner.lock().unwrap();

    // prendi (o crea) il gruppo per questa room
    let gs = map.entry(room_id).or_insert_with(|| {
        println!("[MLS] creating new group for room {}", room_id);
        make_group_state()
    });

    // identity già presente in questa room? → riusa index
    if let Some(existing) =
        gs.roster.iter().find(|m| m.identity == identity)
    {
        let master_b64 =
            base64::engine::general_purpose::STANDARD.encode(&gs.master_secret);

        let gid_hex = gs.group_id
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        let resp = JoinResponse {
            epoch: gs.epoch,
            group_id: gid_hex,
            room_id,
            master_secret: master_b64,
            sender_index: existing.index,
            roster: gs.roster.clone(),
        };

        println!(
            "[MLS] re-join room={} identity={} → sender_index={} (epoch={})",
            room_id,
            existing.identity,
            existing.index,
            gs.epoch
        );

        return Ok(warp::reply::json(&resp));
    }

    // nuova identity per questa room → assegna nuovo index
    let new_idx = gs.roster.len() as u32;

    gs.roster.push(MemberEntry {
        index: new_idx,
        identity: identity.clone(),
    });

    // NEW: cambio di epoch + nuovo master_secret ad ogni nuovo join
    {
        let new_gs = make_group_state();

        gs.epoch = gs.epoch.saturating_add(1);
        gs.master_secret = new_gs.master_secret;
        // group_id lo lasciamo invariato per questa stanza
    }

    let master_b64 =
        base64::engine::general_purpose::STANDARD.encode(&gs.master_secret);

    let gid_hex = gs.group_id
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    let resp = JoinResponse {
        epoch: gs.epoch,
        group_id: gid_hex,
        room_id,
        master_secret: master_b64,
        sender_index: new_idx,
        roster: gs.roster.clone(),
    };

    println!(
        "[MLS] new join room={} identity={} → sender_index={} (epoch={})",
        room_id,
        identity,
        new_idx,
        gs.epoch
    );

    Ok(warp::reply::json(&resp))
}

// ─────────────────────────────────────────────────────────────
// HANDLER ROSTER (GET /mls/roster?room_id=1234)
// ─────────────────────────────────────────────────────────────

async fn handle_roster(
    query: RosterQuery,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {
    let map = groups.inner.lock().unwrap();

    if let Some(gs) = map.get(&query.room_id) {
        let gid_hex = gs.group_id
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        let resp = RosterResponse {
            epoch: gs.epoch,
            group_id: gid_hex,
            room_id: query.room_id,
            roster: gs.roster.clone(),
        };

        println!(
            "[MLS] roster requested room={} → epoch={}, members={}",
            query.room_id,
            gs.epoch,
            gs.roster.len()
        );

        Ok(warp::reply::json(&resp))
    } else {
        // room mai usata: roster vuoto
        let resp = RosterResponse {
            epoch: 0,
            group_id: String::new(),
            room_id: query.room_id,
            roster: vec![],
        };

        println!(
            "[MLS] roster requested room={} → NO GROUP (empty)",
            query.room_id
        );

        Ok(warp::reply::json(&resp))
    }
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let groups = Groups::new();

    let join_route = warp::path!("mls" / "join")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_groups(groups.clone()))
        .and_then(handle_join);

    let roster_route = warp::path!("mls" / "roster")
        .and(warp::get())
        .and(warp::query::<RosterQuery>())
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

    warp::serve(routes)
        .run(([0, 0, 0, 0], 3000))
        .await;
}

fn with_groups(
    groups: Groups,
) -> impl Filter<Extract = (Groups,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || groups.clone())
}
// ─────────────────────────────────────────────────────────────
// TODO (modello MLS semplificato)
//
// Questo server usa OpenMLS solo come "generatore" di segreti
// per l'epoch corrente (export_secret), senza implementare
// il protocollo MLS completo (Add / Commit / Welcome / Remove).
//
// Attualmente:
//   - ad ogni nuovo join:
//       * l'epoch viene incrementata manualmente
//       * viene generato un nuovo master_secret casuale
//   - i peer già nel gruppo si riallineano richiamando /mls/join
//     (via mlsResync lato webapp)
//
// In una implementazione MLS completa:
//   - l'epoch cambierebbe solo a seguito di Commit validi
//   - il master_secret deriverebbe dalla ratchet MLS condivisa
//   - join/leave sarebbero gestiti tramite Add/Remove/Welcome
//   - il server non dovrebbe "inventare" epoch o segreti
//
// Questa implementazione è intenzionalmente semplificata
// per isolare e studiare l'integrazione MLS → SFrame → WebRTC.
// ─────────────────────────────────────────────────────────────