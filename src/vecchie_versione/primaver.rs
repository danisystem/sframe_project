#![allow(dead_code)]

use std::{
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

mod receiver;
mod sender;

use clap::{Parser, ValueEnum};
use receiver::{Receiver, ReceiverOptions};
use sender::{Sender, SenderOptions};
use sframe::{
    CipherSuite,
    header::SframeHeader,
    ratchet::{RatchetingBaseKey, RatchetingKeyId},
};
use hex;

const AES_GCM_TAG_LEN: usize = 16;

/// converti un array di bytes in stringa binaria leggibile
fn bytes_to_bin(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 9);
    for (i, b) in bytes.iter().enumerate() {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:08b}");
        if i + 1 != bytes.len() {
            s.push(' ');
        }
    }
    s
}

/// stampa info dettagliate di un pacchetto SFrame
/// (header struct + raw HEX/BIN, ciphertext e tag separati)
fn inspect_packet(packet: &[u8]) {
    let header = match SframeHeader::deserialize(packet) {
        Ok(h) => h,
        Err(e) => {
            println!("[inspect_packet] errore deserializzazione header: {e:?}");
            return;
        }
    };
    let header_len = header.len();
    let body_len = packet.len().saturating_sub(header_len);

    let header_bytes = &packet[..header_len];
    let body_bytes = &packet[header_len..];

    println!("┌─ SFrame Packet ──────────────────────────────────────────");
    println!("│ Header struct  : {header}");
    println!("│ Header len     : {header_len} bytes");
    println!("│ Header HEX     : {}", hex::encode(header_bytes));
    println!("│ Header BIN     : {}", bytes_to_bin(header_bytes));
    println!("│ KeyId          : {}", header.key_id());
    println!("│ Counter        : {}", header.counter());
    println!("│ Body len       : {body_len} bytes (ciphertext + tag)");
    if body_len >= AES_GCM_TAG_LEN {
        let ct = &body_bytes[..body_len - AES_GCM_TAG_LEN];
        let tag = &body_bytes[body_len - AES_GCM_TAG_LEN..];
        println!("│ Ciphertext HEX : {}", hex::encode(ct));
        println!("│ Auth Tag HEX   : {}", hex::encode(tag));
    } else {
        println!("│ Body HEX       : {}", hex::encode(body_bytes));
    }
    println!("└──────────────────────────────────────────────────────────");
}

#[derive(Parser, Debug)]
#[command(author, version, about = "SFrame interactive demo: header-as-AAD")]
struct Args {
    /// Cipher suite: AesGcm128Sha256 or AesGcm256Sha512
    #[arg(value_enum, short, long, default_value_t = ArgCipherSuiteVariant::AesGcm128Sha256)]
    cipher_suite: ArgCipherSuiteVariant,

    /// Key id (numeric)
    #[arg(short, long, default_value_t = 3)]
    key_id: u64,

    /// Secret / passphrase used to derive keys
    #[arg(short, long, default_value = "SUPER_SECRET")]
    secret: String,

    /// Optional ratchet bits (demo). If present, sender ratchets per message and receiver is updated too.
    #[arg(long)]
    n_ratchet_bits: Option<u8>,

    /// Optional log level (env RUST_LOG still works); mainly for debug
    #[arg(short, long)]
    log_level: Option<log::Level>,

    /// max counter for MonotonicCounter in sender (default u64::MAX)
    #[arg(long, default_value_t = u64::MAX)]
    max_counter: u64,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum ArgCipherSuiteVariant {
    AesGcm128Sha256,
    AesGcm256Sha512,
}

impl From<ArgCipherSuiteVariant> for CipherSuite {
    fn from(v: ArgCipherSuiteVariant) -> Self {
        match v {
            ArgCipherSuiteVariant::AesGcm128Sha256 => CipherSuite::AesGcm128Sha256,
            ArgCipherSuiteVariant::AesGcm256Sha512 => CipherSuite::AesGcm256Sha512,
        }
    }
}

fn print_instructions() {
    println!("------------------------------------------------------------");
    println!("- Enter text to encrypt; [ENTER] to send");
    println!("- Use :q to quit, CTRL+C for immediate exit");
    println!("- The SFrame header is used as AAD (no external metadata).");
    print!("> ");
    io::stdout().flush().unwrap();
}

fn main() -> anyhow::Result<()> {
    let Args {
        cipher_suite,
        key_id,
        log_level,
        max_counter,
        secret,
        n_ratchet_bits,
    } = Args::parse();

    if let Some(level) = log_level {
        simple_logger::init_with_level(level).unwrap();
        println!("- log level {level}");
    }

    let cipher_suite = cipher_suite.into();

    // opzionale ratchet base
    let (mut base_key, mut runtime_key_id) = if let Some(bits) = n_ratchet_bits {
        let r = RatchetingKeyId::new(key_id, bits);
        let base_key = RatchetingBaseKey::ratchet_forward(r, secret.as_bytes(), cipher_suite).unwrap();
        (Some(base_key), r.into())
    } else {
        (None, key_id)
    };

    // Sender (single instance — counter evolves con ogni encrypt)
    let mut sender = Sender::from(SenderOptions { key_id: runtime_key_id, cipher_suite, max_counter });
    sender.set_encryption_key(&secret).unwrap();

    // Receiver (single instance)
    let mut receiver = Receiver::from(ReceiverOptions { cipher_suite, frame_validation: None, n_ratchet_bits });
    receiver.set_encryption_key(runtime_key_id, &secret).unwrap();

    // handler Ctrl-C per uscita pulita
    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc::set_handler(move || {
            stop.store(true, Ordering::SeqCst);
        })
        .expect("failed to set Ctrl-C handler");
    }

    print_instructions();
    let stdin = io::stdin();
    for line_res in stdin.lock().lines() {
        if stop.load(Ordering::SeqCst) {
            println!("\n^C — bye 👋");
            break;
        }
        let line = match line_res {
            Ok(s) => s.trim_end().to_string(),
            Err(_) => break,
        };
        if line.eq_ignore_ascii_case(":q") || line.eq_ignore_ascii_case("quit") {
            println!("bye 👋");
            break;
        }
        if line.is_empty() {
            print_instructions();
            continue;
        }

        // Ratchet per messaggio (solo se richiesto): nella demo aggiorniamo anche il receiver
        if let Some(base) = base_key.as_mut() {
            let (new_id, material) = base.next_base_key().unwrap();
            println!("- Ratcheting sender key, step {}", new_id.ratchet_step());
            sender.ratchet_encryption_key(new_id, &material).unwrap();
            receiver.set_encryption_key(new_id, &material).unwrap(); // demo: keep in sync
            runtime_key_id = new_id.into();
        }

        // Costruiamo SOLO il payload: NON mettiamo metadati AAD esterni.
        // L'AAD sarà l'header SFrame che la libreria usa internamente.
        let payload = line.as_bytes();
        let skip = 0_usize;

        println!("- Encrypting payload: \"{}\"", line);
        let encrypted = match sender.encrypt(payload, skip) {
            Ok(s) => s,
            Err(e) => {
                println!("Encryption failed: {e:?}");
                print_instructions();
                continue;
            }
        };
        let packet: Vec<u8> = encrypted.to_vec();

        // Stampiamo il pacchetto: header (che è l'AAD), ciphertext e tag
        println!("Sender → frame cifrato ({} byte totali)", packet.len());
        inspect_packet(&packet);

        // Decifratura: passiamo skip = 0 (nessun AAD esterno aspettato)
        match receiver.decrypt(&packet, skip) {
            Ok(decrypted) => {
                // qui decrypted contiene solo il payload (perché non avevamo AAD esterno)
                println!("- Payload (dec)    : {}", String::from_utf8_lossy(decrypted));
            }
            Err(e) => {
                println!("- Decryption FAILED (auth tag mismatch or other): {e:?}");
            }
        }

        print_instructions();
    }

    Ok(())
}
