// ─────────────────────────────────────────────────────────────
// MLS SERVER – Delivery Service E2EE (Postino Cieco)
// ─────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use warp::Filter;
use serde::{Serialize, Deserialize};

// ─────────────────────────────────────────────────────────────
// STRUCTS (Le "Lettere" che il postino gestisce)
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct MemberEntry {
    index: u32,
    identity: String,
    // Il KeyPackage pubblico generato dal client (in Base64)
    key_package: String, 
    // Il Welcome message cifrato destinato a questo utente (in Base64)
    welcome_message: Option<String>, 
}

#[derive(Debug, Deserialize)]
struct JoinRequest {
    identity: String,
    room_id: u32,
    key_package: String, // Ora il client DEVE inviare il suo pacchetto
}

#[derive(Debug, Serialize)]
struct JoinResponse {
    epoch: u64,
    room_id: u32,
    sender_index: u32,
    is_creator: bool, // Diciamo al client se è il primo (deve creare lui il gruppo!)
    roster: Vec<MemberEntry>,
}

#[derive(Debug, Deserialize)]
struct WelcomeRequest {
    room_id: u32,
    target_identity: String,
    welcome_message: String,
}

#[derive(Debug, Serialize)]
struct GenericResponse {
    success: bool,
}

#[derive(Debug, Deserialize)]
struct RosterQuery {
    room_id: u32,
}

#[derive(Debug, Serialize)]
struct RosterResponse {
    epoch: u64,
    room_id: u32,
    roster: Vec<MemberEntry>,
}

#[derive(Clone)]
struct GroupState {
    epoch: u64,
    roster: Vec<MemberEntry>,
}

#[derive(Clone)]
struct Groups {
    // room_id → stato della stanza
    inner: Arc<Mutex<HashMap<u32, GroupState>>>,
}

impl Groups {
    fn new() -> Self {
        Groups {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

// 1. Un utente entra e deposita il suo KeyPackage
async fn handle_join(
    req: JoinRequest,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut map = groups.inner.lock().unwrap();

    let gs = map.entry(req.room_id).or_insert_with(|| {
        println!("[MLS-DS] Stanza {} creata", req.room_id);
        GroupState {
            epoch: 1,
            roster: vec![],
        }
    });

    let is_creator = gs.roster.is_empty();

    // Se l'utente esiste già, aggiorniamo il suo KeyPackage (magari ha ricaricato la pagina)
    if let Some(existing) = gs.roster.iter_mut().find(|m| m.identity == req.identity) {
        existing.key_package = req.key_package.clone();
        existing.welcome_message = None; // Resettiamo eventuali vecchi inviti
        
        println!("[MLS-DS] Re-join room={} identity={} index={}", req.room_id, req.identity, existing.index);
        
        return Ok(warp::reply::json(&JoinResponse {
            epoch: gs.epoch,
            room_id: req.room_id,
            sender_index: existing.index,
            is_creator,
            roster: gs.roster.clone(),
        }));
    }

    // Nuovo utente
    let new_idx = gs.roster.len() as u32;
    gs.roster.push(MemberEntry {
        index: new_idx,
        identity: req.identity.clone(),
        key_package: req.key_package,
        welcome_message: None, // Aspetta che il creatore gli mandi l'invito
    });

    // NOTA: Non avanziamo l'epoch qui. L'epoch avanza quando il creatore carica il Welcome.

    println!("[MLS-DS] Nuovo join room={} identity={} index={}", req.room_id, req.identity, new_idx);

    Ok(warp::reply::json(&JoinResponse {
        epoch: gs.epoch,
        room_id: req.room_id,
        sender_index: new_idx,
        is_creator,
        roster: gs.roster.clone(),
    }))
}

// 2. Il creatore carica un Welcome message per un nuovo utente
async fn handle_welcome(
    req: WelcomeRequest,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut map = groups.inner.lock().unwrap();

    if let Some(gs) = map.get_mut(&req.room_id) {
        if let Some(target) = gs.roster.iter_mut().find(|m| m.identity == req.target_identity) {
            target.welcome_message = Some(req.welcome_message);
            gs.epoch += 1; // Un utente è stato aggiunto ufficialmente, l'epoch avanza!
            
            println!("[MLS-DS] Welcome caricato per {} in room {} (Nuova Epoch: {})", req.target_identity, req.room_id, gs.epoch);
            return Ok(warp::reply::json(&GenericResponse { success: true }));
        }
    }

    Ok(warp::reply::json(&GenericResponse { success: false }))
}

// 3. I client chiedono la lista dei partecipanti (e controllano la posta)
async fn handle_roster(
    query: RosterQuery,
    groups: Groups,
) -> Result<impl warp::Reply, warp::Rejection> {
    let map = groups.inner.lock().unwrap();

    if let Some(gs) = map.get(&query.room_id) {
        Ok(warp::reply::json(&RosterResponse {
            epoch: gs.epoch,
            room_id: query.room_id,
            roster: gs.roster.clone(),
        }))
    } else {
        Ok(warp::reply::json(&RosterResponse {
            epoch: 0,
            room_id: query.room_id,
            roster: vec![],
        }))
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

    let welcome_route = warp::path!("mls" / "welcome")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_groups(groups.clone()))
        .and_then(handle_welcome);

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
        .or(welcome_route)
        .or(roster_route)
        .with(cors);

    println!("MLS Delivery Service running on http://0.0.0.0:3000");

    warp::serve(routes)
        .run(([0, 0, 0, 0], 3000))
        .await;
}

fn with_groups(
    groups: Groups,
) -> impl Filter<Extract = (Groups,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || groups.clone())
}