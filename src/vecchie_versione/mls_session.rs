// src/mls_session.rs

use std::io::{Read, Write};
use std::net::TcpStream;

use anyhow::{anyhow, Result};
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;

/// Segreti MLS che useremo come base per SFrame
#[derive(Debug, Clone)]
pub struct MlsSessionKeys {
    pub epoch: u64,
    pub audio_secret: Vec<u8>,
    pub video_secret: Vec<u8>,
    pub base_kid: u64,
}

/// Ruolo del peer rispetto alla sessione
#[derive(Debug, Clone, Copy)]
pub enum MlsRole {
    Server,
    Client,
}

/// Mappatura completa dei KID per audio/video, send/recv
#[derive(Debug, Clone, Copy)]
pub struct KidMapping {
    pub send_aud: u64,
    pub send_vid: u64,
    pub recv_aud: u64,
    pub recv_vid: u64,
}

/// Crea un gruppo MLS locale (1 membro) e ne esporta:
/// - un segreto per l'audio ("SFRAME_AUDIO", 32 byte)
/// - un segreto per il video ("SFRAME_VIDEO", 32 byte)
/// - un seed per i KID ("SFRAME_KID_SEED", 8 byte → u64)
fn mls_generate_keys() -> Result<MlsSessionKeys> {
    let provider = OpenMlsRustCrypto::default();

    // Ciphersuite "standard" del Quick Start
    let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    // Credenziale locale ("peer") + chiave di firma
    let credential = BasicCredential::new(b"peer".to_vec());
    let signature_keys = SignatureKeyPair::new(ciphersuite.signature_algorithm())
        .map_err(|e| anyhow!("SignatureKeyPair::new failed: {e:?}"))?;

    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signature_keys.public().into(),
    };

    // Config del gruppo
    let group_config = MlsGroupCreateConfig::builder()
        .use_ratchet_tree_extension(true)
        .build();

    // Gruppo con un solo membro (noi)
    let group = MlsGroup::new(
        &provider,
        &signature_keys,
        &group_config,
        credential_with_key,
    )?;

    // Epoch MLS come u64 (es. per logging / derivazioni future)
    let epoch_u64 = group.epoch().as_u64();

    // Segreti derivati dal master secret di gruppo
    let audio = group
        .export_secret(provider.crypto(), "SFRAME_AUDIO", &[], 32)
        .map_err(|e| anyhow!("export_secret AUDIO failed: {e:?}"))?;

    let video = group
        .export_secret(provider.crypto(), "SFRAME_VIDEO", &[], 32)
        .map_err(|e| anyhow!("export_secret VIDEO failed: {e:?}"))?;

    let kid_seed = group
        .export_secret(provider.crypto(), "SFRAME_KID_SEED", &[], 8)
        .map_err(|e| anyhow!("export_secret KID_SEED failed: {e:?}"))?;

    let mut arr = [0u8; 8];
    arr.copy_from_slice(&kid_seed[..8]);
    let base_kid = u64::from_le_bytes(arr);

    println!(
        "[MLS] local group created → epoch = {epoch_u64}, base_kid = {base_kid}, audio_len = {}, video_len = {}",
        audio.len(),
        video.len()
    );

    Ok(MlsSessionKeys {
        epoch: epoch_u64,
        audio_secret: audio,
        video_secret: video,
        base_kid,
    })
}

/// Layout del messaggio iniziale server → client:
/// [u64 epoch][u64 base_kid]
/// [u32 len_audio][audio_secret...]
/// [u32 len_video][video_secret...]
fn mls_send_keys(stream: &mut TcpStream, sk: &MlsSessionKeys) -> std::io::Result<()> {
    // epoch
    stream.write_all(&sk.epoch.to_le_bytes())?;
    // base_kid
    stream.write_all(&sk.base_kid.to_le_bytes())?;

    // audio_secret (len + data)
    let len_a = sk.audio_secret.len() as u32;
    stream.write_all(&len_a.to_le_bytes())?;
    stream.write_all(&sk.audio_secret)?;

    // video_secret (len + data)
    let len_v = sk.video_secret.len() as u32;
    stream.write_all(&len_v.to_le_bytes())?;
    stream.write_all(&sk.video_secret)?;

    Ok(())
}

fn mls_recv_keys(stream: &mut TcpStream) -> std::io::Result<MlsSessionKeys> {
    let mut buf8 = [0u8; 8];
    let mut buf4 = [0u8; 4];

    // epoch
    stream.read_exact(&mut buf8)?;
    let epoch = u64::from_le_bytes(buf8);

    // base_kid
    stream.read_exact(&mut buf8)?;
    let base_kid = u64::from_le_bytes(buf8);

    // audio_secret
    stream.read_exact(&mut buf4)?;
    let len_a = u32::from_le_bytes(buf4) as usize;
    let mut audio = vec![0u8; len_a];
    stream.read_exact(&mut audio)?;

    // video_secret
    stream.read_exact(&mut buf4)?;
    let len_v = u32::from_le_bytes(buf4) as usize;
    let mut video = vec![0u8; len_v];
    stream.read_exact(&mut video)?;

    println!(
        "[MLS] recv: epoch = {epoch}, base_kid = {base_kid}, audio_len = {}, video_len = {}",
        audio.len(),
        video.len()
    );

    Ok(MlsSessionKeys {
        epoch,
        audio_secret: audio,
        video_secret: video,
        base_kid,
    })
}

/// Schema generalizzabile per N peer:
///
/// Dato un `base_kid` globale e un `sender_index` (0,1,2,...),
/// assegna:
///   - audio_kid(i) = base_kid + 2*i
///   - video_kid(i) = base_kid + 2*i + 1
///
/// Nella demo a 2 peer:
///   - server → sender_index = 0
///   - client → sender_index = 1
pub fn kid_for_sender(base_kid: u64, sender_index: u64) -> (u64, u64) {
    let aud = base_kid + 2 * sender_index;
    let vid = base_kid + 2 * sender_index + 1;
    (aud, vid)
}

/// A partire dal base_kid deriviamo KID per:
/// - il nostro ruolo (send_*),
/// - il peer remoto (recv_*).
///
/// Schema pensato come "mini gruppo" generalizzabile:
///   - server: sender_index_self = 0, sender_index_peer = 1
///   - client: sender_index_self = 1, sender_index_peer = 0
fn compute_kids(role: MlsRole, base_kid: u64) -> KidMapping {
    match role {
        MlsRole::Server => {
            let self_idx = 0u64;
            let peer_idx = 1u64;

            let (self_aud, self_vid) = kid_for_sender(base_kid, self_idx);
            let (peer_aud, peer_vid) = kid_for_sender(base_kid, peer_idx);

            KidMapping {
                send_aud: self_aud,
                send_vid: self_vid,
                recv_aud: peer_aud,
                recv_vid: peer_vid,
            }
        }
        MlsRole::Client => {
            let self_idx = 1u64;
            let peer_idx = 0u64;

            let (self_aud, self_vid) = kid_for_sender(base_kid, self_idx);
            let (peer_aud, peer_vid) = kid_for_sender(base_kid, peer_idx);

            KidMapping {
                send_aud: self_aud,
                send_vid: self_vid,
                recv_aud: peer_aud,
                recv_vid: peer_vid,
            }
        }
    }
}

/// Handshake lato server:
/// - crea gruppo MLS,
/// - deriva segreti + base_kid,
/// - li manda al client su TCP,
/// - calcola i KID per il ruolo "Server".
pub fn server_handshake(stream: &mut TcpStream) -> Result<(MlsSessionKeys, KidMapping)> {
    let sk = mls_generate_keys()?;
    mls_send_keys(stream, &sk)?;
    let kids = compute_kids(MlsRole::Server, sk.base_kid);

    println!(
        "[MLS] KID mapping (server) → send_aud={}, send_vid={}, recv_aud={}, recv_vid={}",
        kids.send_aud, kids.send_vid, kids.recv_aud, kids.recv_vid
    );

    Ok((sk, kids))
}

/// Handshake lato client:
/// - riceve segreti + base_kid dal server,
/// - calcola i KID per il ruolo "Client".
pub fn client_handshake(stream: &mut TcpStream) -> Result<(MlsSessionKeys, KidMapping)> {
    let sk = mls_recv_keys(stream)?;
    let kids = compute_kids(MlsRole::Client, sk.base_kid);

    println!(
        "[MLS] KID mapping (client) → send_aud={}, send_vid={}, recv_aud={}, recv_vid={}",
        kids.send_aud, kids.send_vid, kids.recv_aud, kids.recv_vid
    );

    Ok((sk, kids))
}
