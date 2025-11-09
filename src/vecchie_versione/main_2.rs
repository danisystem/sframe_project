#![allow(dead_code)]

use std::{
    fs::File,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
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

/* ───────────────────────────── Helpers ───────────────────────────── */

/// Converte un array di bytes in stringa binaria leggibile (solo per REPL verboso).
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

/// Stampa dettagli completi del pacchetto SFrame (usata nel REPL).
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

/// Stampa compatta per file-mode: dimensioni, kid, ctr e nota su IV/nonce.
fn inspect_packet_compact(packet: &[u8]) {
    match SframeHeader::deserialize(packet) {
        Ok(h) => {
            let header_len = h.len();
            let body_len = packet.len().saturating_sub(header_len);
            let (ct_len, tag_len) = if body_len >= AES_GCM_TAG_LEN {
                (body_len - AES_GCM_TAG_LEN, AES_GCM_TAG_LEN)
            } else {
                (body_len, 0)
            };
            println!(
                "[frame] kid={} ctr={} | aad(header)={}B, ct={}B, tag={}B, total={}B",
                h.key_id(),
                h.counter(),
                header_len,
                ct_len,
                tag_len,
                packet.len()
            );
            println!("        IV/nonce: derivato internamente (non serializzato)");
        }
        Err(e) => {
            println!("[frame] errore header: {e:?}");
        }
    }
}

/* ───────────────────────────── CLI ───────────────────────────── */

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

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum ArgMode {
    /// Modalità originale interattiva su stdin
    Interactive,
    /// Cifratura file → concatenazione di frame SFrame con prefisso u32 LE
    Enc,
    /// Decifratura file .sframe → file originale
    Dec,
}

#[derive(Parser, Debug)]
#[command(author, version, about = "SFrame demo: header-as-AAD (REPL) + file mode (enc/dec)")]
struct Args {
    /// Cipher suite: AesGcm128Sha256 or AesGcm256Sha512
    #[arg(value_enum, short, long, default_value_t = ArgCipherSuiteVariant::AesGcm128Sha256)]
    cipher_suite: ArgCipherSuiteVariant,

    /// Key id (numeric)
    #[arg(short, long, default_value_t = 3)]
    key_id: u64,

    /// Secret / passphrase usato per derivare le chiavi
    #[arg(short, long, default_value = "SUPER_SECRET")]
    secret: String,

    /// Ratchet (demo): se presente, il sender ratchetta per messaggio; il receiver viene aggiornato in sync
    #[arg(long)]
    n_ratchet_bits: Option<u8>,

    /// Log level (facoltativo)
    #[arg(short, long)]
    log_level: Option<log::Level>,

    /// max counter per MonotonicCounter nel sender (default u64::MAX)
    #[arg(long, default_value_t = u64::MAX)]
    max_counter: u64,

    /// Modalità: interactive | enc | dec
    #[arg(long, value_enum, default_value_t = ArgMode::Interactive)]
    mode: ArgMode,

    /// File di input (per enc/dec)
    #[arg(long)]
    input: Option<PathBuf>,

    /// File di output (per enc/dec)
    #[arg(long)]
    output: Option<PathBuf>,

    /// Dimensione chunk in bytes per il file-mode
    #[arg(long, default_value_t = 16 * 1024)]
    chunk: usize,

    /// Stampa dettagli per ogni frame (header/AAD, MAC, ctr ecc.)
    #[arg(long, default_value_t = false)]
    inspect: bool,
}

/* ─────────────────────── File-mode helpers ─────────────────────── */

use std::io::{BufReader, BufWriter};

fn write_u32_le(mut w: impl Write, n: u32) -> io::Result<()> {
    let b = n.to_le_bytes();
    w.write_all(&b)
}
fn read_u32_le(mut r: impl BufRead) -> io::Result<Option<u32>> {
    let mut b = [0u8; 4];
    match r.read_exact(&mut b) {
        Ok(()) => Ok(Some(u32::from_le_bytes(b))),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

/// Cifra un file arbitrario in una sequenza di frame SFrame length-prefixed.
fn encrypt_file_sframe(
    sender: &mut Sender,
    input: &PathBuf,
    output: &PathBuf,
    chunk: usize,
    inspect: bool,
) -> anyhow::Result<()> {
    let infile = File::open(input)?;
    let mut r = BufReader::new(infile);
    let outfile = File::create(output)?;
    let mut w = BufWriter::new(outfile);

    let mut buf = vec![0u8; chunk];
    let mut i = 0usize;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 { break; }
        let payload = &buf[..n];

        // skip=0: nessun AAD esterno; tutto nel payload
        let frame_bytes = sender
            .encrypt(payload, 0)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;

        let len = u32::try_from(frame_bytes.len()).expect("frame troppo grande per u32");
        write_u32_le(&mut w, len)?;
        w.write_all(frame_bytes)?;
        if inspect {
            println!("[enc] chunk #{i} pt_in={}B", n);
            inspect_packet_compact(frame_bytes);
        }
        i += 1;
    }
    w.flush()?;
    Ok(())
}

/// Decifra un file prodotto da `encrypt_file_sframe`.
fn decrypt_file_sframe(
    receiver: &mut Receiver,
    input: &PathBuf,
    output: &PathBuf,
    inspect: bool,
) -> anyhow::Result<()> {
    let infile = File::open(input)?;
    let mut r = BufReader::new(infile);
    let outfile = File::create(output)?;
    let mut w = BufWriter::new(outfile);

    let mut i = 0usize;
    loop {
        let Some(len) = read_u32_le(&mut r)? else { break; };
        let mut frame = vec![0u8; len as usize];
        r.read_exact(&mut frame)?;
        if inspect {
            println!("[dec] frame #{i} enc_len={}B", len);
            inspect_packet_compact(&frame);
        }
        let dec = receiver
            .decrypt(&frame, 0)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        if inspect {
            println!("      -> pt_out={}B", dec.len());
        }
        w.write_all(dec)?;
        i += 1;
    }
    w.flush()?;
    Ok(())
}

/* ─────────────────────────── REPL UI ─────────────────────────── */

fn print_instructions() {
    println!("------------------------------------------------------------");
    println!("- Digita testo da cifrare; [ENTER] per inviare");
    println!("- :q per uscire, CTRL+C per uscita immediata");
    println!("- L'header SFrame funge da AAD (nessun metadato esterno).");
    print!("> ");
    io::stdout().flush().unwrap();
}

/* ───────────────────────────── main ───────────────────────────── */

fn main() -> anyhow::Result<()> {
    let Args {
        cipher_suite,
        key_id,
        log_level,
        max_counter,
        secret,
        n_ratchet_bits,
        mode,
        input,
        output,
        chunk,
        inspect,
    } = Args::parse();

    if let Some(level) = log_level {
        simple_logger::init_with_level(level).unwrap();
        println!("- log level {level}");
    }

    let cipher_suite = CipherSuite::from(cipher_suite);

    // opzionale ratchet base
    let (mut base_key, mut runtime_key_id) = if let Some(bits) = n_ratchet_bits {
        let r = RatchetingKeyId::new(key_id, bits);
        let base_key =
            RatchetingBaseKey::ratchet_forward(r, secret.as_bytes(), cipher_suite).unwrap();
        (Some(base_key), r.into())
    } else {
        (None, key_id)
    };

    // Sender (single instance — counter evolve ad ogni encrypt)
    let mut sender =
        Sender::from(SenderOptions { key_id: runtime_key_id, cipher_suite, max_counter });
    sender.set_encryption_key(&secret).unwrap();

    // Receiver (single instance)
    let mut receiver =
        Receiver::from(ReceiverOptions { cipher_suite, frame_validation: None, n_ratchet_bits });
    receiver.set_encryption_key(runtime_key_id, &secret).unwrap();

    match mode {
        ArgMode::Interactive => {
            // === REPL originale ===
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
                    println!("\n^C — bye");
                    break;
                }
                let line = match line_res {
                    Ok(s) => s.trim_end().to_string(),
                    Err(_) => break,
                };
                if line.eq_ignore_ascii_case(":q") || line.eq_ignore_ascii_case("quit") {
                    println!("bye");
                    break;
                }
                if line.is_empty() {
                    print_instructions();
                    continue;
                }

                // Ratchet per messaggio (solo se richiesto)
                if let Some(base) = base_key.as_mut() {
                    let (new_id, material) = base.next_base_key().unwrap();
                    println!("- Ratcheting sender key, step {}", new_id.ratchet_step());
                    sender.ratchet_encryption_key(new_id, &material).unwrap();
                    receiver.set_encryption_key(new_id, &material).unwrap(); // demo: keep in sync
                    runtime_key_id = new_id.into();
                }

                // Solo payload: nessun AAD esterno. L'AAD è l'header SFrame interno.
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

                // Stampa pacchetto: header (AAD), ciphertext e tag
                println!("Sender → frame cifrato ({} byte totali)", packet.len());
                inspect_packet(&packet);

                // Decifratura
                match receiver.decrypt(&packet, skip) {
                    Ok(decrypted) => {
                        println!("- Payload (dec)    : {}", String::from_utf8_lossy(decrypted));
                    }
                    Err(e) => {
                        println!("- Decryption FAILED (auth tag mismatch o altro): {e:?}");
                    }
                }

                print_instructions();
            }

            Ok(())
        }
        ArgMode::Enc => {
            let input = input.expect("--input è richiesto in --mode enc");
            let output = output.unwrap_or_else(|| {
                let mut p = input.clone();
                p.set_extension("sframe");
                p
            });
            println!("- Encrypting file: {} → {}", input.display(), output.display());
            encrypt_file_sframe(&mut sender, &input, &output, chunk, inspect)?;
            println!("✓ Done");
            Ok(())
        }
        ArgMode::Dec => {
            let input = input.expect("--input è richiesto in --mode dec");
            let output = output.unwrap_or_else(|| {
                // prova a ripristinare l'estensione .mp4/.mp3 se entri da .sframe
                let mut p = input.clone();
                if p.extension().and_then(|e| e.to_str()) == Some("sframe") {
                    p.set_extension("dec");
                } else {
                    p.set_extension("dec");
                }
                p
            });
            println!("- Decrypting file: {} → {}", input.display(), output.display());
            decrypt_file_sframe(&mut receiver, &input, &output, inspect)?;
            println!("✓ Done");
            Ok(())
        }
    }
}
