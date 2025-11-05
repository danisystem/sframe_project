use anyhow::Result;
use std::{
    io::Write,
    net::TcpStream,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
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

// ---------- CLI helpers ----------
fn has_flag(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
}
fn read_flag_u32(args: &[String], name: &str, def: u32) -> u32 {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(def)
    } else {
        def
    }
}
fn read_flag_str<'a>(args: &'a [String], name: &str, def: &'a str) -> &'a str {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.get(i + 1).map(|s| s.as_str()).unwrap_or(def)
    } else {
        def
    }
}
fn parse_suite(s: &str) -> Option<CipherSuite> {
    match s.to_ascii_lowercase().as_str() {
        "aes-gcm128-sha256" | "aesgcm128" | "128" => Some(CipherSuite::AesGcm128Sha256),
        "aes-gcm256-sha512" | "aesgcm256" | "256" => Some(CipherSuite::AesGcm256Sha512),
        _ => None,
    }
}

// ---------- framing ----------
const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

fn send_frame(stream: &Arc<Mutex<TcpStream>>, sid: u8, pkt: &[u8]) -> std::io::Result<()> {
    let mut s = stream.lock().unwrap();
    s.write_all(&[sid])?;
    s.write_all(&(pkt.len() as u32).to_le_bytes())?;
    s.write_all(pkt)?;
    Ok(())
}

// ---------- inspect ----------
fn inspect_packet_compact(prefix: &str, packet: &[u8]) {
    if let Ok(h) = SframeHeader::deserialize(packet) {
        let hdr = h.len();
        let body = packet.len().saturating_sub(hdr);
        let (ct, tag) = if body >= 16 { (body - 16, 16) } else { (body, 0) };
        println!(
            "{prefix} kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
            h.key_id(),
            h.counter(),
            hdr,
            ct,
            tag,
            packet.len()
        );
    }
}

// ---------- video helpers ----------
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
        (pref, w.abs_diff(want_w), h.abs_diff(want_h), fps.abs_diff(want_fps))
    }
    let mut best: Option<(CameraFormat, (u32, u32, u32, u32))> = None;
    for f in formats {
        let s = score(f, want_w, want_h, want_fps);
        match &mut best {
            None => best = Some((f.clone(), s)),
            Some((bf, bs)) => {
                if s < *bs {
                    *bf = f.clone();
                    *bs = s;
                }
            }
        }
    }
    best.map(|(bf, _)| bf)
}

fn main() -> Result<()> {
    // USO:
    // tx_av <HOST:PORT>
    //       [--device N] [--width W] [--height H] [--fps F] [--quality Q]
    //       [--key-audio KA] [--key-video KV] [--secret S] [--suite SUITE]
    //       [--inspect] [--list]
    //
    // Esempi:
    //   tx_av 127.0.0.1:7000 --list
    //   tx_av 127.0.0.1:7000 --device 0 --width 640 --height 480 --fps 30 --quality 70
    //                        --key-audio 1 --key-video 2 --secret SUPER_SECRET --suite aes-gcm256-sha512 --inspect

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || has_flag(&args, "--help") {
        eprintln!("Uso: tx_av <HOST:PORT> [--device N] [--width W] [--height H] [--fps F] [--quality Q] [--key-audio KA] [--key-video KV] [--secret S] [--suite SUITE] [--inspect] [--list]");
        return Ok(());
    }

    let dst = &args[1];
    let list = has_flag(&args, "--list");
    let device = read_flag_u32(&args, "--device", 0);
    let want_w = read_flag_u32(&args, "--width", 640);
    let want_h = read_flag_u32(&args, "--height", 480);
    let want_fps = read_flag_u32(&args, "--fps", 30);
    let quality = read_flag_u32(&args, "--quality", 70) as u8;

    let key_audio = read_flag_u32(&args, "--key-audio", 1) as u64;
    let key_video = read_flag_u32(&args, "--key-video", 2) as u64;
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512"))
        .unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");

    // Elenco device/formati video
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

    // SFrame sender per audio/video
    let mut s_audio = Sender::with_cipher_suite(key_audio, suite);
    s_audio.set_encryption_key(secret.as_bytes())?;
    let mut s_video = Sender::with_cipher_suite(key_video, suite);
    s_video.set_encryption_key(secret.as_bytes())?;

    // TCP
    let stream = Arc::new(Mutex::new(TcpStream::connect(dst)?));
    stream.lock().unwrap().set_nodelay(true)?;
    println!("[tx_av] connected {}", dst);

    // ----------------- VIDEO thread -----------------
    {
        let stream = Arc::clone(&stream);
        let mut s_video = s_video; // move
        thread::spawn(move || {
            // probe
            let req_probe = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
            let mut cam =
                Camera::new(CameraIndex::Index(device), req_probe).expect("open cam (probe)");
            let fmts = cam.compatible_camera_formats().expect("fmts");
            let best = pick_best_format(&fmts, want_w, want_h, want_fps).expect("pick format");
            let use_w = best.resolution().width();
            let use_h = best.resolution().height();
            let use_fps = best.frame_rate();
            eprintln!(
                "[tx_av][video] richiesto ~{}x{}@{}; scelto {}x{}@{} {:?}",
                want_w, want_h, want_fps, use_w, use_h, use_fps, best.format()
            );
            drop(cam);
            let req_exact = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(best));
            let mut cam =
                Camera::new(CameraIndex::Index(device), req_exact).expect("open cam exact");
            cam.open_stream().expect("open_stream");

            let frame_dt = Duration::from_millis((1000 / use_fps.max(1)) as u64);
            let mut last = Instant::now();
            let mut n: usize = 0;
            let mut jpeg_buf: Vec<u8> = Vec::with_capacity(256 * 1024);

            loop {
                let rgb = match cam.frame() {
                    Ok(f) => f.decode_image::<RgbFormat>().expect("rgb"),
                    Err(e) => {
                        eprintln!("[tx_av][video] frame err: {e}");
                        continue;
                    }
                };
                let img: ImageBuffer<Rgb<u8>, _> = match ImageBuffer::from_raw(use_w, use_h, rgb) {
                    Some(b) => b,
                    None => {
                        eprintln!("[tx_av][video] size mismatch");
                        continue;
                    }
                };
                jpeg_buf.clear();
                let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
                if let Err(e) = enc.encode(&img, use_w, use_h, ColorType::Rgb8) {
                    eprintln!("[tx_av][video] jpeg err: {e}");
                    continue;
                }
                let pkt = match s_video.encrypt_frame(&jpeg_buf) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[tx_av][video] sframe err: {e:?}");
                        continue;
                    }
                };
                if inspect && (n % 30 == 0) {
                    inspect_packet_compact("[TX][VID]", pkt);
                }
                if let Err(e) = send_frame(&stream, SID_VIDEO, pkt) {
                    eprintln!("[tx_av][video] send err: {e}");
                    break;
                }
                n = n.wrapping_add(1);
                let elapsed = last.elapsed();
                if elapsed < frame_dt {
                    thread::sleep(frame_dt - elapsed);
                }
                last = Instant::now();
            }
        });
    }

    // ----------------- AUDIO thread -----------------
    {
        let stream = Arc::clone(&stream);
        let mut s_audio = s_audio;
        thread::spawn(move || {
            let host = cpal::default_host();
            let dev = host
                .default_input_device()
                .expect("no default input device");
            let config = dev
                .default_input_config()
                .expect("no default input config");

            let sample_rate = config.sample_rate().0 as usize;
            let channels = config.channels() as usize;
            eprintln!(
                "[tx_av][audio] input {:?} {:?}Hz {}ch",
                config.sample_format(),
                sample_rate,
                channels
            );

            // Raggruppa ~20ms per pacchetto
            let chunk_frames = (sample_rate / 50).max(1); // ~20ms
            let mut acc_i16: Vec<i16> = Vec::with_capacity(chunk_frames * channels);

            let err_fn = |e| eprintln!("[tx_av][audio] stream err: {e}");

            let stream_in = match config.sample_format() {
                cpal::SampleFormat::I16 => dev
                    .build_input_stream(
                        &config.into(),
                        move |data: &[i16], _| {
                            acc_i16.extend_from_slice(data);
                            if acc_i16.len() >= chunk_frames * channels {
                                let pkt = match s_audio.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[tx_av][audio] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream, SID_AUDIO, pkt) {
                                    eprintln!("[tx_av][audio] send err: {e}");
                                }
                                acc_i16.clear();
                            }
                        },
                        err_fn,
                        None,
                    )
                    .expect("build input I16"),
                cpal::SampleFormat::U16 => dev
                    .build_input_stream(
                        &config.clone().into(),
                        move |data: &[u16], _| {
                            // center to i16
                            acc_i16.extend(data.iter().map(|&x| (x as i32 - 32768) as i16));
                            if acc_i16.len() >= chunk_frames * channels {
                                let pkt = match s_audio.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[tx_av][audio] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream, SID_AUDIO, pkt) {
                                    eprintln!("[tx_av][audio] send err: {e}");
                                }
                                acc_i16.clear();
                            }
                        },
                        err_fn,
                        None,
                    )
                    .expect("build input U16"),
                cpal::SampleFormat::F32 => dev
                    .build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            acc_i16.extend(data.iter().map(|&x| {
                                let v = (x * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32);
                                v as i16
                            }));
                            if acc_i16.len() >= chunk_frames * channels {
                                let pkt = match s_audio.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[tx_av][audio] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream, SID_AUDIO, pkt) {
                                    eprintln!("[tx_av][audio] send err: {e}");
                                }
                                acc_i16.clear();
                            }
                        },
                        err_fn,
                        None,
                    )
                    .expect("build input F32"),
                _ => panic!("Formato audio non gestito"),
            };

            stream_in.play().expect("start input");
            loop {
                thread::sleep(Duration::from_secs(3600));
            }
        });
    }

    // Thread principale dorme: i due thread fanno il lavoro
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
