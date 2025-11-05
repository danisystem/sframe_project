use anyhow::Result;
use std::io::Write;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::{ColorType, ImageBuffer, Rgb};

use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
};
use nokhwa::{query, Camera};

use sframe::header::SframeHeader;
use sframe::CipherSuite;

mod sender;
use sender::Sender;

// ---- util TCP prefix u32 LE ----
fn write_u32_le(mut w: impl Write, n: u32) -> std::io::Result<()> {
    w.write_all(&n.to_le_bytes())
}

// ---- arg parsing semplice ----
fn has_flag(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
}
fn read_flag_u32(args: &[String], name: &str, def: u32) -> u32 {
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

// ---- inspect helper (compatto) ----
fn inspect_packet_compact(packet: &[u8]) {
    if let Ok(h) = SframeHeader::deserialize(packet) {
        let hdr = h.len();
        let body = packet.len().saturating_sub(hdr);
        let (ct, tag) = if body >= 16 { (body - 16, 16) } else { (body, 0) };
        println!(
            "[TX][SFRAME] kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
            h.key_id(), h.counter(), hdr, ct, tag, packet.len()
        );
    }
}

// ---- scelta formato migliore (prefer MJPEG, poi YUYV) ----
fn pick_best_format(
    formats: &[CameraFormat],
    want_w: u32,
    want_h: u32,
    want_fps: u32,
) -> Option<CameraFormat> {
    fn score(fmt: &CameraFormat, want_w: u32, want_h: u32, want_fps: u32) -> (u32, u32, u32, u32) {
        let res = fmt.resolution();
        let (w, h, fps) = (res.width(), res.height(), fmt.frame_rate());
        let pref = match fmt.format() {
            FrameFormat::MJPEG => 0,
            FrameFormat::YUYV => 1,
            _ => 2,
        };
        let dw = w.abs_diff(want_w);
        let dh = h.abs_diff(want_h);
        let df = fps.abs_diff(want_fps);
        (pref, dw, dh, df)
    }
    let mut best: Option<(CameraFormat, (u32, u32, u32, u32))> = None;
    for f in formats {
        let s = score(f, want_w, want_h, want_fps);
        match &mut best {
            None => best = Some((f.clone(), s)),
            Some((bf, bs)) => if s < *bs { *bf = f.clone(); *bs = s; },
        }
    }
    best.map(|(bf, _)| bf)
}

fn main() -> Result<()> {
    // USO:
    // tx_video <HOST:PORT>
    //          [--device N] [--width W] [--height H] [--fps F]
    //          [--quality Q] [--key-id K] [--secret S] [--suite SUITE]
    //          [--inspect] [--list]
    //
    // Esempi:
    //   tx_video 127.0.0.1:6000 --list
    //   tx_video 127.0.0.1:6000 --device 0 --width 640 --height 480 --fps 15 --quality 70 --key-id 2 --secret SUPER_SECRET --suite aes-gcm256-sha512 --inspect

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || has_flag(&args, "--help") {
        eprintln!("Uso: tx_video <HOST:PORT> [--device N] [--width W] [--height H] [--fps F] [--quality Q] [--key-id K] [--secret S] [--suite SUITE] [--inspect] [--list]");
        eprintln!("Suite: aes-gcm128-sha256 | aes-gcm256-sha512");
        return Ok(());
    }

    let dst = &args[1];
    let list = has_flag(&args, "--list");
    let device = read_flag_u32(&args, "--device", 0);
    let want_w = read_flag_u32(&args, "--width", 640);
    let want_h = read_flag_u32(&args, "--height", 480);
    let want_fps = read_flag_u32(&args, "--fps", 15);
    let quality = read_flag_u32(&args, "--quality", 70) as u8;
    let key_id = read_flag_u32(&args, "--key-id", 2) as u64;
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = read_flag_str(&args, "--suite", "aes-gcm256-sha512");
    let inspect = has_flag(&args, "--inspect");

    // elenco device/formati
    if list {
        let cams = query(ApiBackend::Auto)?;
        println!("Found {} camera(s):", cams.len());
        for (i, info) in cams.iter().enumerate() {
            println!("[{}] {}", i, info.human_name());
            let req = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
            if let Ok(mut cam) = Camera::new(CameraIndex::Index(i as u32), req) {
                if let Ok(fmts) = cam.compatible_camera_formats() {
                    for f in fmts {
                        println!(
                            "   - {:?} {}x{} @{}fps",
                            f.format(),
                            f.resolution().width(),
                            f.resolution().height(),
                            f.frame_rate()
                        );
                    }
                }
            }
        }
        return Ok(());
    }

    // SFrame sender
    let suite = parse_suite(suite).unwrap_or(CipherSuite::AesGcm256Sha512);
    let mut s = Sender::with_cipher_suite(key_id, suite);
    s.set_encryption_key(secret.as_bytes())?;

    // 1) probe formati compatibili
    let req_probe = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
    let mut cam = Camera::new(CameraIndex::Index(device), req_probe)?;
    let fmts = cam.compatible_camera_formats()?;
    if fmts.is_empty() {
        anyhow::bail!("Nessun formato compatibile trovato.");
    }

    // 2) scegli il migliore
    let best = pick_best_format(&fmts, want_w, want_h, want_fps)
        .ok_or_else(|| anyhow::anyhow!("Impossibile selezionare un formato"))?;
    let use_w = best.resolution().width();
    let use_h = best.resolution().height();
    let use_fps = best.frame_rate();
    println!(
        "[tx_video] richiesto ~{}x{}@{}fps; selezionato {}x{}@{}fps {:?}",
        want_w, want_h, want_fps, use_w, use_h, use_fps, best.format()
    );

    // 3) riapri con formato esatto + output RGB
    drop(cam);
    let req_exact = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(best));
    let mut cam = Camera::new(CameraIndex::Index(device), req_exact)?;
    cam.open_stream()?;
    println!(
        "[tx_video] capturing {}x{} @{}fps → {} (JPEG quality {})",
        use_w, use_h, use_fps, dst, quality
    );

    // TCP connect
    let mut stream = TcpStream::connect(dst)?;
    stream.set_nodelay(true)?;
    println!("[tx_video] connected to {}", dst);

    let mut jpeg_buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    let frame_dt = Duration::from_millis((1000 / use_fps.max(1)) as u64);
    let mut last = Instant::now();
    let mut n: usize = 0;

    loop {
        let rgb = cam.frame()?.decode_image::<RgbFormat>()?;
        let img: ImageBuffer<Rgb<u8>, _> = match ImageBuffer::from_raw(use_w, use_h, rgb) {
            Some(b) => b,
            None => { eprintln!("[tx_video] frame size mismatch, skip"); continue; }
        };

        jpeg_buf.clear();
        let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
        enc.encode(&img, use_w, use_h, ColorType::Rgb8)?;

        let pkt = s.encrypt_frame(&jpeg_buf)?;
        if inspect && (n % 30 == 0) { inspect_packet_compact(pkt); }
        write_u32_le(&mut stream, u32::try_from(pkt.len())?)?;
        stream.write_all(pkt)?;

        n = n.wrapping_add(1);
        let elapsed = last.elapsed();
        if elapsed < frame_dt { std::thread::sleep(frame_dt - elapsed); }
        last = Instant::now();
    }
}
