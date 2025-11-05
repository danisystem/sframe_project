#![allow(dead_code)]

use std::{
    fs::File,
    io::{self, BufRead, Read, Write},
    net::{TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
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
    Interactive,
    Enc,
    Dec,
    TcpSend,
    TcpRecv,
    UdpSend,
    UdpRecv,
}

#[derive(Parser, Debug)]
#[command(author, version, about = "SFrame demo: REPL + file + TCP/UDP stream modes")]
struct Args {
    #[arg(value_enum, short, long, default_value_t = ArgCipherSuiteVariant::AesGcm128Sha256)]
    cipher_suite: ArgCipherSuiteVariant,

    #[arg(short, long, default_value_t = 3)]
    key_id: u64,

    #[arg(short, long, default_value = "SUPER_SECRET")]
    secret: String,

    #[arg(long)]
    n_ratchet_bits: Option<u8>,

    #[arg(short, long)]
    log_level: Option<log::Level>,

    #[arg(long, default_value_t = u64::MAX)]
    max_counter: u64,

    #[arg(long, value_enum, default_value_t = ArgMode::Interactive)]
    mode: ArgMode,

    // I/O per file mode
    #[arg(long)]
    input: Option<PathBuf>,
    #[arg(long)]
    output: Option<PathBuf>,

    /// chunk per frame (anche per TCP/UDP). Per UDP tienilo sotto ~1200B.
    #[arg(long, default_value_t = 1000)]
    chunk: usize,

    /// stampa dettaglio frame
    #[arg(long, default_value_t = false)]
    inspect: bool,

    /// indirizzo host (per TCP/UDP)
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// porta (per TCP/UDP)
    #[arg(long, default_value_t = 5000)]
    port: u16,
}

/* ─────────────────────── File-mode helpers ─────────────────────── */

use std::io::{BufReader, BufWriter};

fn write_u32_le(mut w: impl Write, n: u32) -> io::Result<()> {
    w.write_all(&n.to_le_bytes())
}
fn read_u32_le(mut r: impl BufRead) -> io::Result<Option<u32>> {
    let mut b = [0u8; 4];
    match r.read_exact(&mut b) {
        Ok(()) => Ok(Some(u32::from_le_bytes(b))),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

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
        let frame = sender.encrypt_frame(&buf[..n]).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        write_u32_le(&mut w, u32::try_from(frame.len())?)?;
        w.write_all(frame)?;
        if inspect {
            println!("[enc:file] chunk #{i} pt_in={}B", n);
            inspect_packet_compact(frame);
        }
        i += 1;
    }
    w.flush()?;
    Ok(())
}

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
            println!("[dec:file] frame #{i} enc_len={}B", len);
            inspect_packet_compact(&frame);
        }
        let dec = receiver.decrypt_frame(&frame).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        if inspect {
            println!("           -> pt_out={}B", dec.len());
        }
        w.write_all(dec)?;
        i += 1;
    }
    w.flush()?;
    Ok(())
}

/* ─────────────────────── TCP stream helpers ───────────────────────
   Protocollo: [u32 len][frame bytes] ripetuto sullo stream TCP.
*/

fn tcp_send(
    mut sender: Sender,
    host: &str,
    port: u16,
    mut source: impl Read,
    chunk: usize,
    inspect: bool,
) -> anyhow::Result<()> {
    let addr = format!("{host}:{port}");
    println!("[tcp-send] connecting to {addr} …");
    let mut stream = TcpStream::connect(addr)?;
    stream.set_nodelay(true)?;
    let mut buf = vec![0u8; chunk];
    let mut i = 0usize;
    loop {
        let n = source.read(&mut buf)?;
        if n == 0 { break; }
        let frame = sender.encrypt_frame(&buf[..n]).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        write_u32_le(&mut stream, u32::try_from(frame.len())?)?;
        stream.write_all(frame)?;
        if inspect {
            println!("[tcp-send] frame #{i} pt_in={}B", n);
            inspect_packet_compact(frame);
        }
        i += 1;
    }
    println!("[tcp-send] done");
    Ok(())
}

fn read_exact_u32(mut s: &TcpStream) -> io::Result<u32> {
    let mut b = [0u8; 4];
    s.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn tcp_recv(
    mut receiver: Receiver,
    host: &str,
    port: u16,
    mut sink: impl Write,
    inspect: bool,
) -> anyhow::Result<()> {
    let addr = format!("{host}:{port}");
    println!("[tcp-recv] listening on {addr} …");
    let listener = TcpListener::bind(addr)?;
    let (mut stream, peer) = listener.accept()?;
    println!("[tcp-recv] connected: {}", peer);

    let mut i = 0usize;
    loop {
        let len = match read_exact_u32(&stream) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };
        let mut frame = vec![0u8; len as usize];
        stream.read_exact(&mut frame)?;
        if inspect {
            println!("[tcp-recv] frame #{i} enc_len={}B", len);
            inspect_packet_compact(&frame);
        }
        let dec = receiver.decrypt_frame(&frame).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        if inspect {
            println!("            -> pt_out={}B", dec.len());
        }
        sink.write_all(dec)?;
        i += 1;
    }
    println!("[tcp-recv] done");
    Ok(())
}

/* ─────────────────────── UDP stream helpers ───────────────────────
   Protocollo: 1 datagramma = 1 frame SFrame (niente prefisso).
   Mantieni chunk ~1000-1200B per stare sotto l’MTU.
*/

fn udp_send(
    mut sender: Sender,
    host: &str,
    port: u16,
    mut source: impl Read,
    chunk: usize,
    inspect: bool,
) -> anyhow::Result<()> {
    let addr = format!("{host}:{port}");
    println!("[udp-send] will send to {addr}");
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect(&addr)?;
    socket.set_nonblocking(false)?;
    let mut buf = vec![0u8; chunk];
    let mut i = 0usize;
    loop {
        let n = source.read(&mut buf)?;
        if n == 0 { break; }
        let frame = sender.encrypt_frame(&buf[..n]).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let sent = socket.send(frame)?;
        if inspect {
            println!("[udp-send] frame #{i} pt_in={}B, sent={}B", n, sent);
            inspect_packet_compact(frame);
        }
        i += 1;
        // pacing minimo per simulare un framerate e non saturare
        std::thread::sleep(Duration::from_millis(10));
    }
    println!("[udp-send] done");
    Ok(())
}

fn udp_recv(
    mut receiver: Receiver,
    host: &str,
    port: u16,
    mut sink: impl Write,
    inspect: bool,
) -> anyhow::Result<()> {
    let addr = format!("{host}:{port}");
    println!("[udp-recv] binding {addr}");
    let socket = UdpSocket::bind(&addr)?;
    socket.set_read_timeout(Some(Duration::from_millis(100)))?;

    let mut buf = vec![0u8; 65535];
    let mut i = 0usize;
    loop {
        match socket.recv_from(&mut buf) {
            Ok((n, peer)) => {
                let frame = &buf[..n];
                if inspect {
                    println!("[udp-recv] from {} frame #{i} enc_len={}B", peer, n);
                    inspect_packet_compact(frame);
                }
                match receiver.decrypt_frame(frame) {
                    Ok(dec) => {
                        if inspect {
                            println!("           -> pt_out={}B", dec.len());
                        }
                        sink.write_all(dec)?;
                    }
                    Err(e) => {
                        eprintln!("[udp-recv] decrypt error: {e:?} (datagram scartato)");
                    }
                }
                i += 1;
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/* ─────────────────────────── REPL UI ─────────────────────────── */

fn print_instructions() {
    println!("------------------------------------------------------------");
    println!("- Digita testo da cifrare; [ENTER] per inviare");
    println!("- :q per uscire, CTRL+C per uscita immediata");
    println!("- L'header SFrame è AAD (nessun metadato esterno).");
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
        host,
        port,
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

    // Sender
    let mut sender =
        Sender::from(SenderOptions { key_id: runtime_key_id, cipher_suite, max_counter });
    sender.set_encryption_key(&secret).unwrap();

    // Receiver
    let mut receiver =
        Receiver::from(ReceiverOptions { cipher_suite, frame_validation: None, n_ratchet_bits });
    receiver.set_encryption_key(runtime_key_id, &secret).unwrap();

    match mode {
        ArgMode::Interactive => {
            // REPL minimale (come prima)
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

                if let Some(base) = base_key.as_mut() {
                    let (new_id, material) = base.next_base_key().unwrap();
                    println!("- Ratcheting sender key, step {}", new_id.ratchet_step());
                    sender.ratchet_encryption_key(new_id, &material).unwrap();
                    receiver.set_encryption_key(new_id, &material).unwrap();
                    runtime_key_id = new_id.into();
                }

                let payload = line.as_bytes();
                println!("- Encrypting payload: \"{}\"", line);
                let encrypted = match sender.encrypt_frame(payload) {
                    Ok(s) => s,
                    Err(e) => {
                        println!("Encryption failed: {e:?}");
                        print_instructions();
                        continue;
                    }
                };
                let packet: Vec<u8> = encrypted.to_vec();
                println!("Sender → frame cifrato ({} byte totali)", packet.len());
                inspect_packet(&packet);

                match receiver.decrypt_frame(&packet) {
                    Ok(decrypted) => {
                        println!("- Payload (dec)    : {}", String::from_utf8_lossy(decrypted));
                    }
                    Err(e) => {
                        println!("- Decryption FAILED: {e:?}");
                    }
                }

                print_instructions();
            }

            Ok(())
        }
        ArgMode::Enc => {
            let input = input.expect("--input è richiesto in --mode enc");
            let output = output.unwrap_or_else(|| { let mut p = input.clone(); p.set_extension("sframe"); p });
            println!("- Encrypting file: {} → {}", input.display(), output.display());
            encrypt_file_sframe(&mut sender, &input, &output, chunk, inspect)?;
            println!("✓ Done");
            Ok(())
        }
        ArgMode::Dec => {
            let input = input.expect("--input è richiesto in --mode dec");
            let output = output.unwrap_or_else(|| { let mut p = input.clone(); p.set_extension("dec"); p });
            println!("- Decrypting file: {} → {}", input.display(), output.display());
            decrypt_file_sframe(&mut receiver, &input, &output, inspect)?;
            println!("✓ Done");
            Ok(())
        }
        ArgMode::TcpSend => {
            if let Some(path) = input {
                let mut f = File::open(&path)?;
                tcp_send(sender, &host, port, &mut f, chunk, inspect)?;
            } else {
                let stdin = io::stdin();
                tcp_send(sender, &host, port, stdin.lock(), chunk, inspect)?;
            }
            Ok(())
        }
        ArgMode::TcpRecv => {
            if let Some(path) = output {
                let mut f = File::create(&path)?;
                tcp_recv(receiver, &host, port, &mut f, inspect)?;
            } else {
                let stdout = io::stdout();
                tcp_recv(receiver, &host, port, stdout.lock(), inspect)?;
            }
            Ok(())
        }
        ArgMode::UdpSend => {
            if let Some(path) = input {
                let mut f = File::open(&path)?;
                udp_send(sender, &host, port, &mut f, chunk, inspect)?;
            } else {
                let stdin = io::stdin();
                udp_send(sender, &host, port, stdin.lock(), chunk, inspect)?;
            }
            Ok(())
        }
        ArgMode::UdpRecv => {
            if let Some(path) = output {
                let mut f = File::create(&path)?;
                udp_recv(receiver, &host, port, &mut f, inspect)?;
            } else {
                let stdout = io::stdout();
                udp_recv(receiver, &host, port, stdout.lock(), inspect)?;
            }
            Ok(())
            // termina con CTRL+C
        }
    }
}
