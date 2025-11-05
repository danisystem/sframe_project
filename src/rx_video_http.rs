use anyhow::Result;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use sframe::header::SframeHeader;
use sframe::CipherSuite;

mod receiver;
use receiver::Receiver;

// ----------- utils -----------
fn read_u32_le(mut r: impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn has_flag(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
}
fn read_flag_u64(args: &[String], name: &str, def: u64) -> u64 {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(def)
    } else { def }
}
fn read_flag_str<'a>(args: &'a [String], name: &str, def: &'a str) -> &'a str {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.get(i + 1).map(|s| s.as_str()).unwrap_or(def)
    } else { def }
}
fn parse_suite(s: &str) -> Option<CipherSuite> {
    match s.to_ascii_lowercase().as_str() {
        "aes-gcm128-sha256" | "aesgcm128" | "128" => Some(CipherSuite::AesGcm128Sha256),
        "aes-gcm256-sha512" | "aesgcm256" | "256" => Some(CipherSuite::AesGcm256Sha512),
        _ => None,
    }
}

fn inspect_packet_compact(packet: &[u8]) {
    if let Ok(h) = SframeHeader::deserialize(packet) {
        let hdr = h.len();
        let body = packet.len().saturating_sub(hdr);
        let (ct, tag) = if body >= 16 { (body - 16, 16) } else { (body, 0) };
        println!(
            "[RX][SFRAME] kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
            h.key_id(), h.counter(), hdr, ct, tag, packet.len()
        );
    }
}

// ----------- HTTP MJPEG server -----------
// Manteniamo una lista di client HTTP connessi a cui pushare i JPEG.
type Clients = Arc<Mutex<Vec<TcpStream>>>;

fn http_server_thread(addr: &str, clients: Clients) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr)?;
    println!("[http] listening on http://{addr}/  (apri nel browser)");
    for conn in listener.incoming() {
        match conn {
            Ok(mut s) => {
                // Legge una richiesta base (solo la prima linea, ignoriamo il resto)
                let mut req = [0u8; 1024];
                let _ = s.read(&mut req);

                // Risposta MJPEG
                let headers = concat!(
                    "HTTP/1.0 200 OK\r\n",
                    "Cache-Control: no-cache\r\n",
                    "Pragma: no-cache\r\n",
                    "Connection: close\r\n",
                    "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n",
                    "\r\n"
                );
                if s.write_all(headers.as_bytes()).is_ok() {
                    s.flush().ok();
                    // Aggiungi alla lista client
                    s.set_write_timeout(Some(Duration::from_millis(200))).ok();
                    clients.lock().unwrap().push(s);
                    println!("[http] viewer connesso (tot {})", clients.lock().unwrap().len());
                }
            }
            Err(e) => eprintln!("[http] accept err: {e}"),
        }
    }
    Ok(())
}

// Invia un JPEG a tutti i viewer HTTP connessi.
// Rimuove i client che falliscono in scrittura.
fn http_broadcast_jpeg(clients: &Clients, jpeg: &[u8]) {
    let mut guard = clients.lock().unwrap();
    let mut i = 0;
    while i < guard.len() {
        let s = &mut guard[i];
        let part_hdr = format!(
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            jpeg.len()
        );
        let res = s.write_all(part_hdr.as_bytes())
            .and_then(|_| s.write_all(jpeg))
            .and_then(|_| s.write_all(b"\r\n"));
        if res.is_err() {
            // client morto: rimuovi
            let _ = s.shutdown(std::net::Shutdown::Both);
            guard.remove(i);
            println!("[http] viewer disconnesso (tot {})", guard.len());
        } else {
            i += 1;
        }
    }
}

fn main() -> Result<()> {
    // USO:
    // rx_video_http <BIND:PORT_RX> [--http HOST:PORT_HTTP] [--key-id K] [--secret S] [--suite SUITE] [--inspect]
    // Esempio:
    // rx_video_http 0.0.0.0:6000 --http 127.0.0.1:8080 --key-id 2 --secret SUPER_SECRET --suite aes-gcm256-sha512 --inspect
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || has_flag(&args, "--help") {
        eprintln!("Uso: rx_video_http <BIND:PORT_RX> [--http HOST:PORT_HTTP] [--key-id K] [--secret S] [--suite SUITE] [--inspect]");
        return Ok(());
    }
    let bind = &args[1];
    let http_addr = read_flag_str(&args, "--http", "127.0.0.1:8080");
    let key_id = read_flag_u64(&args, "--key-id", 2);
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512"))
        .unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");

    // Receiver SFrame
    let mut r = Receiver::from(receiver::ReceiverOptions {
        cipher_suite: suite,
        frame_validation: None,
        n_ratchet_bits: None,
    });
    r.set_encryption_key(key_id, secret.as_bytes())?;

    // Avvia HTTP thread
    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    {
        let clients = clients.clone();
        let http_addr = http_addr.to_string();
        thread::spawn(move || {
            if let Err(e) = http_server_thread(&http_addr, clients) {
                eprintln!("[http] server error: {e}");
            }
        });
    }

    // TCP (dal trasmettitore video)
    let listener = TcpListener::bind(bind)?;
    println!("[rx] listening on {}", bind);
    let (mut stream, peer) = listener.accept()?;
    println!("[rx] connected: {}", peer);

    // Primo frame (salva per debug)
    loop {
        let len = match read_u32_le(&mut stream) {
            Ok(n) => n,
            Err(e) => { eprintln!("[rx] first: read len err: {e}"); continue; }
        };
        let mut buf = vec![0u8; len as usize];
        if let Err(e) = stream.read_exact(&mut buf) {
            eprintln!("[rx] first: read payload err: {e}");
            continue;
        }
        if inspect { inspect_packet_compact(&buf); }
        let plain = match r.decrypt_frame(&buf) {
            Ok(p) => p,
            Err(e) => { eprintln!("[rx] first: decrypt err: {e:?}"); continue; }
        };
        std::fs::write("first_dec.jpg", plain).ok();
        println!("[rx] first frame OK: {} bytes (salvato first_dec.jpg)", plain.len());

        // manda a tutti gli HTTP viewers
        http_broadcast_jpeg(&clients, plain);
        break;
    }

    // Loop successivi
    loop {
        let len = match read_u32_le(&mut stream) {
            Ok(n) => n,
            Err(e) => { eprintln!("[rx] read len err: {e}"); break; }
        };
        let mut buf = vec![0u8; len as usize];
        if let Err(e) = stream.read_exact(&mut buf) {
            eprintln!("[rx] read payload err: {e}");
            break;
        }
        if inspect { inspect_packet_compact(&buf); }
        let plain = match r.decrypt_frame(&buf) {
            Ok(p) => p,
            Err(e) => { eprintln!("[rx] decrypt err: {e:?}"); continue; }
        };
        // broadcast JPEG
        http_broadcast_jpeg(&clients, plain);
    }

    Ok(())
}
