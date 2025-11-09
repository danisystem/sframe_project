use anyhow::Result;
use std::io::Read;
use std::net::TcpListener;
use std::time::Duration;

use image::{DynamicImage, GenericImageView};
use minifb::{Key, Window, WindowOptions};

use sframe::header::SframeHeader;
use sframe::CipherSuite;

mod receiver;
use receiver::Receiver;

// --- u32 LE ---
fn read_u32_le(mut r: impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

// --- args ---
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

// --- pixel packing helpers ---
fn img_to_rgbx32(img: &DynamicImage) -> (usize, usize, Vec<u32>) {
    // 0x00RRGGBB (default)
    let rgb8 = img.to_rgb8();
    let (w, h) = rgb8.dimensions();
    let mut buf = Vec::with_capacity((w * h) as usize);
    for px in rgb8.pixels() {
        let [r, g, b] = px.0;
        buf.push(((r as u32) << 16) | ((g as u32) << 8) | (b as u32));
    }
    (w as usize, h as usize, buf)
}
fn img_to_bgrx32(img: &DynamicImage) -> (usize, usize, Vec<u32>) {
    // 0x00BBGGRR (alcuni backend aspettano questo)
    let rgb8 = img.to_rgb8();
    let (w, h) = rgb8.dimensions();
    let mut buf = Vec::with_capacity((w * h) as usize);
    for px in rgb8.pixels() {
        let [r, g, b] = px.0;
        buf.push(((b as u32) << 16) | ((g as u32) << 8) | (r as u32));
    }
    (w as usize, h as usize, buf)
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

// semplice checkerboard per verificare che minifb disegni
fn make_checkerboard(w: usize, h: usize) -> Vec<u32> {
    let mut fb = vec![0u32; w * h];
    for y in 0..h {
        for x in 0..w {
            let c = if ((x / 16) + (y / 16)) % 2 == 0 { 0x00222222 } else { 0x00DDDDDD };
            fb[y * w + x] = c;
        }
    }
    fb
}

fn main() -> Result<()> {
    // USO:
    // rx_video <BIND:PORT> [--key-id K] [--secret S] [--suite SUITE] [--inspect] [--bgr]
    //  --bgr: usa packing 0x00BBGGRR (invece di 0x00RRGGBB)
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || has_flag(&args, "--help") {
        eprintln!("Uso: rx_video <BIND:PORT> [--key-id K] [--secret S] [--suite SUITE] [--inspect] [--bgr]");
        return Ok(());
    }
    let bind = &args[1];
    let key_id = read_flag_u64(&args, "--key-id", 2);
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512"))
        .unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");
    let use_bgr = has_flag(&args, "--bgr");

    // Receiver SFrame
    let mut r = Receiver::from(receiver::ReceiverOptions {
        cipher_suite: suite,
        frame_validation: None,
        n_ratchet_bits: None,
    });
    r.set_encryption_key(key_id, secret.as_bytes())?;

    let listener = TcpListener::bind(bind)?;
    println!("[rx_video] listening on {}", bind);
    let (mut stream, peer) = listener.accept()?;
    println!("[rx_video] connected: {}", peer);

    // primo frame valido
    let (mut width, mut height, mut fb);
    loop {
        let len = match read_u32_le(&mut stream) {
            Ok(n) => n,
            Err(e) => { eprintln!("[rx_video] first: read len err: {e}"); continue; }
        };
        let mut buf = vec![0u8; len as usize];
        if let Err(e) = stream.read_exact(&mut buf) {
            eprintln!("[rx_video] first: read payload err: {e}");
            continue;
        }
        if inspect { inspect_packet_compact(&buf); }
        let plain = match r.decrypt_frame(&buf) {
            Ok(p) => p,
            Err(e) => { eprintln!("[rx_video] first: decrypt err: {e:?}"); continue; }
        };

        // salva il primo JPEG decifrato per verifica
        let _ = std::fs::write("first_dec.jpg", plain);

        let img = match image::load_from_memory(plain) {
            Ok(i) => i,
            Err(e) => { eprintln!("[rx_video] first: decode err: {e}"); continue; }
        };

        let (w, h, framebuf) = if use_bgr { img_to_bgrx32(&img) } else { img_to_rgbx32(&img) };
        width = w; height = h; fb = framebuf;
        println!("[rx_video] first frame OK: {}x{} (packing {})", width, height, if use_bgr {"BGRX"} else {"RGBX"});
        break;
    }

    // crea finestra e mostra un checkerboard, poi il frame
    let mut window = Window::new(
        "SFrame Video (minifb) — ESC per uscire",
        width,
        height,
        WindowOptions {
            resize: false,
            scale: minifb::Scale::X1,
            ..WindowOptions::default()
        },
    )?;
    window.limit_update_rate(Some(Duration::from_millis(1000 / 60)));

    // test pattern per verificare che il draw funzioni
    let test = make_checkerboard(width, height);
    window.update_with_buffer(&test, width, height)?;
    // ora disegna il primo frame reale
    window.update_with_buffer(&fb, width, height)?;

    // loop
    loop {
        if !window.is_open() || window.is_key_down(Key::Escape) {
            println!("[rx_video] ESC / window closed");
            break;
        }
        let len = match read_u32_le(&mut stream) {
            Ok(n) => n,
            Err(e) => { eprintln!("[rx_video] read len err: {e}"); break; }
        };
        let mut buf = vec![0u8; len as usize];
        if let Err(e) = stream.read_exact(&mut buf) {
            eprintln!("[rx_video] read payload err: {e}");
            break;
        }
        if inspect { inspect_packet_compact(&buf); }

        let plain = match r.decrypt_frame(&buf) {
            Ok(p) => p,
            Err(e) => { eprintln!("[rx_video] decrypt err: {e:?}"); continue; }
        };
        let img = match image::load_from_memory(plain) {
            Ok(i) => i,
            Err(e) => { eprintln!("[rx_video] decode err: {e}"); continue; }
        };

        let (w2, h2) = img.dimensions();
        if w2 as usize != width || h2 as usize != height {
            let (w, h, new_fb) = if use_bgr { img_to_bgrx32(&img) } else { img_to_rgbx32(&img) };
            width = w; height = h; fb = new_fb;
            window = Window::new(
                "SFrame Video (minifb) — ESC per uscire",
                width, height,
                WindowOptions {
                    resize: false,
                    scale: minifb::Scale::X1,
                    ..WindowOptions::default()
                },
            )?;
        } else {
            let (_, _, new_fb) = if use_bgr { img_to_bgrx32(&img) } else { img_to_rgbx32(&img) };
            fb = new_fb;
        }
        if let Err(e) = window.update_with_buffer(&fb, width, height) {
            eprintln!("[rx_video] window update error: {e}");
            break;
        }
    }

    Ok(())
}
