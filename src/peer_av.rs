//! Full‑duplex peer: TX (audio+video) + RX (audio+video) in un solo binario.
//! Mantiene il comportamento che sul Mac **ti funziona**:
//! - finestra/`winit` sul **main thread** (come nel tuo `rx_av.rs`)
//! - **TX video/audio in thread separati** (come nel tuo `tx_av.rs`, che sul Mac è la parte critica → lasciata invariata nella sequenza di init)
//! - un’unica connessione TCP con framing `SID_VIDEO`/`SID_AUDIO`
//! - SFrame identico: `Sender`/`Receiver`, chiavi, suite, `--inspect` ecc.
//!
//! Esempi:
//!  Peer A (server): `cargo run --release --bin peer_av -- --bind 5000 [flags]`
//!  Peer B (client): `cargo run --release --bin peer_av -- --connect 192.168.x.y:5000 [flags]`
//!
//! Flags (unione TX/RX):
//!  `--device N --width W --height H --fps F --quality Q --list --prefer-mjpeg --prefer-nv12
//!   --key-audio KA --key-video KV --secret S --suite SUITE --inspect`

use anyhow::Result;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use image::{ColorType, ImageBuffer, Rgb};
use image::codecs::jpeg::JpegEncoder;

use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType};
use nokhwa::{query, Camera};

use sframe::header::SframeHeader;
use sframe::CipherSuite;

use winit::{
    dpi::LogicalSize,
    event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use pixels::{Pixels, SurfaceTexture};

mod sender;     // riusa i tuoi mod
mod receiver;   // riusa i tuoi mod
use sender::Sender;
use receiver::Receiver;

/* ───────────── Framing ───────────── */
const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

fn send_frame(stream: &Arc<Mutex<TcpStream>>, sid: u8, pkt: &[u8]) -> std::io::Result<()> {
    let mut s = stream.lock().unwrap();
    s.write_all(&[sid])?;
    s.write_all(&(pkt.len() as u32).to_le_bytes())?;
    s.write_all(pkt)?;
    Ok(())
}

fn read_exact_u32(mut r: impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn recv_frame<'a>(s: &mut TcpStream, buf: &'a mut Vec<u8>) -> std::io::Result<(u8, &'a [u8])> {
    let mut sid = [0u8; 1];
    s.read_exact(&mut sid)?;
    let len = read_exact_u32(&mut *s)?;
    buf.resize(len as usize, 0);
    s.read_exact(buf)?;
    Ok((sid[0], &buf[..]))
}

/* ───────────── Inspect ───────────── */
fn inspect_packet_compact(prefix: &str, packet: &[u8]) {
    if let Ok(h) = SframeHeader::deserialize(packet) {
        let hdr = h.len();
        let body = packet.len().saturating_sub(hdr);
        let (ct, tag) = if body >= 16 { (body - 16, 16) } else { (body, 0) };
        println!(
            "{prefix} kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
            h.key_id(), h.counter(), hdr, ct, tag, packet.len()
        );
    }
}

/* ───────────── Helpers CLI ───────────── */
fn has_flag(args: &[String], f: &str) -> bool { args.iter().any(|a| a == f) }
fn read_flag_u32(args: &[String], name: &str, def: u32) -> u32 {
    if let Some(i) = args.iter().position(|a| a == name) { args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(def) } else { def }
}
fn read_flag_u64(args: &[String], name: &str, def: u64) -> u64 {
    if let Some(i) = args.iter().position(|a| a == name) { args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(def) } else { def }
}
fn read_flag_str<'a>(args: &'a [String], name: &str, def: &'a str) -> &'a str {
    if let Some(i) = args.iter().position(|a| a == name) { args.get(i + 1).map(|s| s.as_str()).unwrap_or(def) } else { def }
}
fn parse_suite(s: &str) -> Option<CipherSuite> {
    match s.to_ascii_lowercase().as_str() {
        "aes-gcm128-sha256" | "aesgcm128" | "128" => Some(CipherSuite::AesGcm128Sha256),
        "aes-gcm256-sha512" | "aesgcm256" | "256" => Some(CipherSuite::AesGcm256Sha512),
        _ => None,
    }
}

/* ───────────── OS/backend helpers ───────────── */
#[inline]
fn default_backend() -> ApiBackend {
    #[cfg(target_os = "macos")] { ApiBackend::AVFoundation }
    #[cfg(not(target_os = "macos"))] { ApiBackend::Auto }
}

/* ───────────── Video helpers (TX) ───────────── */
fn pick_best_format(formats: &[CameraFormat], want_w: u32, want_h: u32, want_fps: u32) -> Option<CameraFormat> {
    fn score(fmt: &CameraFormat, want_w: u32, want_h: u32, want_fps: u32) -> (u32,u32,u32,u32) {
        let res = fmt.resolution();
        let (w,h,fps) = (res.width(), res.height(), fmt.frame_rate());
        let pref = match fmt.format() {
            FrameFormat::MJPEG => 0,      // best se disponibile
            FrameFormat::NV12  => 1,      // poi NV12 (più leggero di YUYV)
            FrameFormat::YUYV  => 2,      // infine YUYV
            _ => 3,
        };
        (pref, w.abs_diff(want_w), h.abs_diff(want_h), fps.abs_diff(want_fps))
    }
    let mut best: Option<(CameraFormat,(u32,u32,u32,u32))> = None;
    for f in formats {
        let s = score(f, want_w, want_h, want_fps);
        match &mut best { None => best = Some((f.clone(), s)), Some((bf, bs)) => if s < *bs { *bf = f.clone(); *bs = s; }, }
    }
    best.map(|(bf,_)| bf)
}

// ───── Audio helpers: remix canali e resampling lineare ─────
fn remix_channels_i16(input: &[i16], src_ch: usize, dst_ch: usize) -> Vec<i16> {
    if src_ch == dst_ch { return input.to_vec(); }
    let frames = input.len() / src_ch;
    let mut out = Vec::with_capacity(frames * dst_ch);
    for f in 0..frames {
        let base = f*src_ch;
        let (l, r) = if src_ch == 1 { (input[base], input[base]) } else { (input[base], input[base+1]) };
        match dst_ch {
            1 => out.push(((l as i32 + r as i32)/2) as i16),
            2 => { out.push(l); out.push(r); },
            _ => { out.push(l); out.push(r); }
        }
    }
    out
}

fn resample_linear_i16(input: &[i16], src_sr: u32, dst_sr: u32, ch: usize) -> Vec<i16> {
    if src_sr == 0 || dst_sr == 0 || src_sr == dst_sr { return input.to_vec(); }
    let frames_in = input.len() / ch;
    if frames_in == 0 { return Vec::new(); }
    let frames_out = ((frames_in as u64) * (dst_sr as u64) / (src_sr as u64)) as usize;
    let mut out = vec![0i16; frames_out * ch];
    for c in 0..ch {
        let mut t_in = 0.0f64;
        let step = (src_sr as f64) / (dst_sr as f64);
        for fo in 0..frames_out {
            let i0 = t_in.floor() as usize;
            let i1 = (i0+1).min(frames_in.saturating_sub(1));
            let frac = t_in - (i0 as f64);
            let s0 = input[i0*ch + c] as f64;
            let s1 = input[i1*ch + c] as f64;
            let s = s0 + (s1 - s0) * frac;
            out[fo*ch + c] = s.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
            t_in += step;
        }
    }
    out
}

/* ───────────── Main ───────────── */
fn main() -> Result<()> {
    // CLI unificata:
    // peer_av --bind <PORT> | --connect <HOST:PORT>
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 || has_flag(&args, "--help") {
        eprintln!("Uso: peer_av --bind <PORT> | --connect <HOST:PORT> [--device N] [--width W] [--height H] [--fps F] [--quality Q] [--key-audio KA] [--key-video KV] [--secret S] [--suite SUITE] [--inspect] [--list] [--prefer-mjpeg] [--prefer-nv12]");
        return Ok(());
    }

    let device = read_flag_u32(&args, "--device", 0);
    let want_w = read_flag_u32(&args, "--width", 640);
    let want_h = read_flag_u32(&args, "--height", 480);
    let want_fps = read_flag_u32(&args, "--fps", 30);
    let quality = read_flag_u32(&args, "--quality", 70) as u8;
    let key_audio = read_flag_u64(&args, "--key-audio", 1);
    let key_video = read_flag_u64(&args, "--key-video", 2);
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512")).unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");
    let list = has_flag(&args, "--list");
    let prefer_mjpeg = has_flag(&args, "--prefer-mjpeg");
    let prefer_nv12  = has_flag(&args, "--prefer-nv12");

    // LIST: elenca camere e formati e termina
    if list {
        let backend = default_backend();
        let cams = query(backend)?;
        println!("Found {} camera(s):", cams.len());
        for (i, info) in cams.iter().enumerate() {
            println!("[{}] {}", i, info.human_name());
            let req = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
            match Camera::new(CameraIndex::Index(i as u32), req) {
                Ok(mut cam) => match cam.compatible_camera_formats() {
                    Ok(mut fmts) => {
                        if prefer_mjpeg {
                            let only: Vec<_> = fmts.iter().cloned().filter(|f| matches!(f.format(), FrameFormat::MJPEG)).collect();
                            if !only.is_empty() { fmts = only; }
                        } else if prefer_nv12 {
                            let only: Vec<_> = fmts.iter().cloned().filter(|f| matches!(f.format(), FrameFormat::NV12)).collect();
                            if !only.is_empty() { fmts = only; }
                        }
                        for f in fmts {
                            println!("   - {:?} {}x{} @{}fps", f.format(), f.resolution().width(), f.resolution().height(), f.frame_rate());
                        }
                    }
                    Err(e) => eprintln!("   (errore nel leggere i formati: {e})"),
                },
                Err(e) => eprintln!("   (errore nell’aprire la camera: {e})"),
            }
        }
        return Ok(());
    }

    // Connessione TCP
    let base_stream = if args[1] == "--bind" {
        let port = &args[2];
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port))?;
        println!("[peer_av] listening on 0.0.0.0:{}", port);
        let (s, peer) = listener.accept()?; s.set_nodelay(true)?; println!("[peer_av] connected: {}", peer); s
    } else {
        let addr = &args[2];
        println!("[peer_av] connecting {} ...", addr);
        let s = TcpStream::connect(addr)?; s.set_nodelay(true)?; s
    };

    // IMPORTANTISSIMO per il full‑duplex: uno stream dedicato per RX (senza mutex)
    // e un clone separato (con Mutex) per TX. Evita deadlock read-hold → write bloccate.
    let mut stream_read = base_stream;
    let stream_write = Arc::new(Mutex::new(stream_read.try_clone()?));

    // SFrame (Sender/Receiver)
    let mut s_audio = Sender::with_cipher_suite(key_audio, suite);
    s_audio.set_encryption_key(secret.as_bytes())?;
    let mut s_video = Sender::with_cipher_suite(key_video, suite);
    s_video.set_encryption_key(secret.as_bytes())?;

    let mut r_audio = Receiver::from(receiver::ReceiverOptions { cipher_suite: suite, n_ratchet_bits: None });
    r_audio.set_encryption_key(key_audio, secret.as_bytes())?;
    let mut r_video = Receiver::from(receiver::ReceiverOptions { cipher_suite: suite, n_ratchet_bits: None });
    r_video.set_encryption_key(key_video, secret.as_bytes())?;

    // AUDIO OUTPUT (RX) — come rx_av, creato PRIMA dell'event loop
    let host = cpal::default_host();
    let out_dev = host.default_output_device().expect("no default output device");
    let out_cfg = out_dev.default_output_config().expect("no default output config");
    eprintln!("[peer_av][audio-out] {:?} {:?}Hz {}ch", out_cfg.sample_format(), out_cfg.sample_rate().0, out_cfg.channels());

    let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);
    let mut pending: Vec<i16> = Vec::new();
    let err_fn = |e| eprintln!("[peer_av][audio-out] err: {e}");
    let out_stream = match out_cfg.sample_format() {
        cpal::SampleFormat::I16 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [i16], _| {
                let mut idx = 0;
                while idx < out.len() {
                    if pending.is_empty() {
                        if let Ok(mut next) = rx_pcm.try_recv() { pending.append(&mut next); } else { for s in &mut out[idx..] { *s = 0; } break; }
                    }
                    let n = (out.len() - idx).min(pending.len());
                    out[idx..idx+n].copy_from_slice(&pending[..n]);
                    pending.drain(..n); idx += n;
                }
            }, err_fn, None
        )?,
        cpal::SampleFormat::F32 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [f32], _| {
                let mut idx = 0;
                while idx < out.len() {
                    if pending.is_empty() {
                        if let Ok(mut next) = rx_pcm.try_recv() { pending.append(&mut next); } else { for s in &mut out[idx..] { *s = 0.0; } break; }
                    }
                    let n = (out.len() - idx).min(pending.len());
                    for i in 0..n { out[idx+i] = pending[i] as f32 / i16::MAX as f32; }
                    pending.drain(..n); idx += n;
                }
            }, err_fn, None
        )?,
        _ => panic!("Formato audio out non gestito"),
    };
    out_stream.play()?;

    // FRAMEBUFFER VIDEO (RX)
    let fb_video: Arc<Mutex<(usize, usize, Vec<u8>)>> = Arc::new(Mutex::new((640, 480, vec![0u8; 640*480*4])));

    // THREAD RX: legge dal TCP, decifra e smista ad audio/video
    {
        let fb_video = fb_video.clone();
        // stream dedicato per read, SENZA mutex
        let mut tcp = stream_read;
        let out_sr = out_cfg.sample_rate().0 as u32;
        let out_ch = out_cfg.channels() as usize;
        thread::spawn(move || {
            let mut buf = Vec::new();
            // Receiver separati (possono mantenere stato/ratcheting)
            let mut r_audio = r_audio;
            let mut r_video = r_video;
            loop {
                let (sid, pkt) = match recv_frame(&mut tcp, &mut buf) {
                    Ok(v) => v,
                    Err(e) => { eprintln!("[peer_av][RX] tcp read err: {e}"); break; }
                };
                if inspect {
                    match sid {
                        SID_VIDEO => inspect_packet_compact("[RX][VID]", pkt),
                        SID_AUDIO => inspect_packet_compact("[RX][AUD]", pkt),
                        _ => inspect_packet_compact("[RX][UNK]", pkt),
                    }
                }
                match sid {
                    SID_VIDEO => {
                        let plain = match r_video.decrypt_frame(pkt) {
                            Ok(p) => p,
                            Err(e) => { eprintln!("[peer_av][video] decrypt err: {e:?}"); continue; }
                        };
                        let img = match image::load_from_memory(plain) {
                            Ok(i) => i.to_rgba8(),
                            Err(e) => { eprintln!("[peer_av][video] jpeg decode err: {e}"); continue; }
                        };
                        let (w,h) = img.dimensions();
                        let mut fb = fb_video.lock().unwrap();
                        fb.0 = w as usize; fb.1 = h as usize; fb.2 = img.into_raw();
                    }
                    SID_AUDIO => {
                        let plain = match r_audio.decrypt_frame(pkt) {
                            Ok(p) => p,
                            Err(e) => { eprintln!("[peer_av][audio] decrypt err: {e:?}"); continue; }
                        };
                        // payload con header: [u32 src_sr LE][u8 src_ch][PCM i16...]
                        let (src_sr, src_ch, pcm_bytes) = if plain.len() >= 5 {
                            let sr = u32::from_le_bytes([plain[0], plain[1], plain[2], plain[3]]);
                            let ch = plain[4] as usize;
                            (sr.max(1), ch.max(1), &plain[5..])
                        } else {
                            // retro‑compat: stima da chunk ~20ms assumendo stereo
                            let in_i16: &[i16] = bytemuck::cast_slice(&plain);
                            let frames_in = in_i16.len() / 2;
                            let est = (frames_in as u32).saturating_mul(50).max(1);
                            (est, 2, &plain[..])
                        };
                        let in_i16: &[i16] = bytemuck::cast_slice(pcm_bytes);
                        let remixed   = remix_channels_i16(in_i16, src_ch, out_ch);
                        let resampled = resample_linear_i16(&remixed, src_sr, out_sr, out_ch);
                        let _ = tx_pcm.try_send(resampled);
                    }
                    _ => eprintln!("[peer_av] unknown sid: {sid}"),
                }
            }
        });
    }

    // THREAD TX VIDEO — **stessa sequenza del tuo tx_av.rs (mac‑critical)**
    {
        let stream = Arc::clone(&stream_write);
        let mut s_video = s_video;
        thread::spawn(move || {
            // PROBE
            let req_probe = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
            let mut cam = match Camera::new(CameraIndex::Index(device), req_probe) {
                Ok(c) => c, Err(e) => { eprintln!("[peer_av][tx][video] open cam (probe) err: {e}"); return; }
            };
            let mut fmts = cam.compatible_camera_formats().unwrap_or_default();
            // preferenze formato
            if prefer_mjpeg {
                let only: Vec<_> = fmts.iter().cloned().filter(|f| matches!(f.format(), FrameFormat::MJPEG)).collect();
                if !only.is_empty() { fmts = only; }
            } else if prefer_nv12 {
                let only: Vec<_> = fmts.iter().cloned().filter(|f| matches!(f.format(), FrameFormat::NV12)).collect();
                if !only.is_empty() { fmts = only; }
            }
            let best_opt = pick_best_format(&fmts, want_w, want_h, want_fps);

            // FIX MOVE: ricrea CameraIndex ogni volta
            let mk_index = || CameraIndex::Index(device);
            let mut cam = if let Some(best) = best_opt.clone() {
                eprintln!(
                    "[peer_av][tx][video] scelto {}x{}@{} {:?}",
                    best.resolution().width(), best.resolution().height(), best.frame_rate(), best.format()
                );
                let req = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(best));
                Camera::new(mk_index(), req).unwrap_or_else(|_| {
                    let req_fb = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
                    Camera::new(mk_index(), req_fb).expect("fallback default camera")
                })
            } else {
                let req = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
                Camera::new(mk_index(), req).expect("default camera")
            };

            if let Err(e) = cam.open_stream() { eprintln!("[peer_av][tx][video] open_stream err: {e}"); return; }

            let cf = cam.camera_format();
            eprintln!(
                "[peer_av][tx][video] attivo {}x{} @{} {:?}",
                cf.resolution().width(), cf.resolution().height(), cf.frame_rate(), cf.format()
            );

            let use_fps = cf.frame_rate().max(1);
            let frame_dt = Duration::from_millis((1000 / use_fps) as u64);
            if use_fps <= 1 {
                eprintln!("[peer_av][tx][video] WARNING: driver ha negoziato {} fps; prova --prefer-nv12 o risoluzione più bassa.", use_fps);
            }

            let mut last = Instant::now();
            let mut n: usize = 0;
            let mut jpeg_buf = Vec::with_capacity(512 * 1024);

            loop {
                let rgb = match cam.frame() {
                    Ok(f) => match f.decode_image::<RgbFormat>() {
                        Ok(x) => x,
                        Err(e) => { eprintln!("[peer_av][tx][video] decode err: {e}"); continue; }
                    },
                    Err(e) => { eprintln!("[peer_av][tx][video] frame err: {e}"); continue; }
                };

                let cf = cam.camera_format();
                let (w, h) = (cf.resolution().width(), cf.resolution().height());

                let img: ImageBuffer<Rgb<u8>, _> = match ImageBuffer::from_raw(w, h, rgb) {
                    Some(b) => b,
                    None => { eprintln!("[peer_av][tx][video] size mismatch"); continue; }
                };

                jpeg_buf.clear();
                let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
                if let Err(e) = enc.encode(&img, w, h, ColorType::Rgb8) {
                    eprintln!("[peer_av][tx][video] jpeg err: {e}");
                    continue;
                }

                let pkt = match s_video.encrypt_frame(&jpeg_buf) {
                    Ok(p) => p,
                    Err(e) => { eprintln!("[peer_av][tx][video] sframe err: {e:?}"); continue; }
                };

                if inspect && (n % 30 == 0) { inspect_packet_compact("[TX][VID]", pkt); }

                if let Err(e) = send_frame(&stream, SID_VIDEO, pkt) {
                    eprintln!("[peer_av][tx][video] send err: {e}");
                    break;
                }

                n = n.wrapping_add(1);

                let elapsed = last.elapsed();
                if elapsed < frame_dt { thread::sleep(frame_dt - elapsed); }
                last = Instant::now();
            }
        });
    }

    // THREAD TX AUDIO — **con header SR/channels nel payload**
    {
        let stream = Arc::clone(&stream_write);
        let mut s_audio = s_audio;
        thread::spawn(move || {
            let host = cpal::default_host();
            let dev = match host.default_input_device() { Some(d) => d, None => { eprintln!("[peer_av][tx][audio] no default input device"); return; } };
            let config = match dev.default_input_config() { Ok(c) => c, Err(e) => { eprintln!("[peer_av][tx][audio] no default input config: {e}"); return; } };
            let sample_rate = config.sample_rate().0 as usize; let channels = config.channels() as usize;
            eprintln!("[peer_av][tx][audio] input {:?} {:?}Hz {}ch", config.sample_format(), sample_rate, channels);
            let chunk_frames = (sample_rate / 50).max(1); // ~20ms
            let mut acc_i16: Vec<i16> = Vec::with_capacity(chunk_frames * channels);
            let err_fn = |e| eprintln!("[peer_av][tx][audio] stream err: {e}");
            let stream_in = match config.sample_format() {
                cpal::SampleFormat::I16 => dev.build_input_stream(&config.into(), move |data: &[i16], _| {
                    acc_i16.extend_from_slice(data);
                    if acc_i16.len() >= chunk_frames * channels {
                        // payload: [u32 src_sr LE][u8 src_ch][PCM i16...]
                        let mut payload = Vec::with_capacity(5 + acc_i16.len()*2);
                        let sr_le = (sample_rate as u32).to_le_bytes();
                        payload.extend_from_slice(&sr_le);
                        payload.push(channels as u8);
                        payload.extend_from_slice(bytemuck::cast_slice(&acc_i16));
                        let pkt = match s_audio.encrypt_frame(&payload) { Ok(p) => p, Err(e) => { eprintln!("[peer_av][tx][audio] sframe err: {e:?}"); acc_i16.clear(); return; } };
                        let _ = send_frame(&stream, SID_AUDIO, pkt); acc_i16.clear();
                    }
                }, err_fn, None).expect("build input I16"),
                cpal::SampleFormat::U16 => dev.build_input_stream(&config.clone().into(), move |data: &[u16], _| {
                    acc_i16.extend(data.iter().map(|&x| (x as i32 - 32768) as i16));
                    if acc_i16.len() >= chunk_frames * channels {
                        let mut payload = Vec::with_capacity(5 + acc_i16.len()*2);
                        let sr_le = (sample_rate as u32).to_le_bytes();
                        payload.extend_from_slice(&sr_le);
                        payload.push(channels as u8);
                        payload.extend_from_slice(bytemuck::cast_slice(&acc_i16));
                        let pkt = match s_audio.encrypt_frame(&payload) { Ok(p) => p, Err(e) => { eprintln!("[peer_av][tx][audio] sframe err: {e:?}"); acc_i16.clear(); return; } };
                        let _ = send_frame(&stream, SID_AUDIO, pkt); acc_i16.clear();
                    }
                }, err_fn, None).expect("build input U16"),
                cpal::SampleFormat::F32 => dev.build_input_stream(&config.into(), move |data: &[f32], _| {
                    acc_i16.extend(data.iter().map(|&x| { let v = (x * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32); v as i16 }));
                    if acc_i16.len() >= chunk_frames * channels {
                        let mut payload = Vec::with_capacity(5 + acc_i16.len()*2);
                        let sr_le = (sample_rate as u32).to_le_bytes();
                        payload.extend_from_slice(&sr_le);
                        payload.push(channels as u8);
                        payload.extend_from_slice(bytemuck::cast_slice(&acc_i16));
                        let pkt = match s_audio.encrypt_frame(&payload) { Ok(p) => p, Err(e) => { eprintln!("[peer_av][tx][audio] sframe err: {e:?}"); acc_i16.clear(); return; } };
                        let _ = send_frame(&stream, SID_AUDIO, pkt); acc_i16.clear();
                    }
                }, err_fn, None).expect("build input F32"),
                _ => { eprintln!("[peer_av][tx][audio] formato audio non gestito"); return; }
            };
            let _ = stream_in.play();
            loop { thread::sleep(Duration::from_secs(3600)); }
        });
    }

    // ─────────── Event loop (VIDEO DISPLAY RX) — **main thread** (macOS‑safe)
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("SFrame A/V — ESC per uscire")
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
        .unwrap();
    let window_size = window.inner_size();
    let surface_texture = SurfaceTexture::new(window_size.width, window_size.height, &window);
    let mut pixels = Pixels::new(640, 480, surface_texture)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested
                    | WindowEvent::KeyboardInput { input: KeyboardInput { virtual_keycode: Some(VirtualKeyCode::Escape), state: ElementState::Pressed, .. }, .. }, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::RedrawRequested(_) => {
                let (w,h,buf) = { let fb = fb_video.lock().unwrap(); (fb.0, fb.1, fb.2.clone()) };
                if w>0 && h>0 && buf.len()==w*h*4 { pixels.resize_surface(w as u32, h as u32); pixels.resize_buffer(w as u32, h as u32); pixels.frame_mut().copy_from_slice(&buf); }
                if pixels.render().is_err() { *control_flow = ControlFlow::Exit; }
            }
            Event::MainEventsCleared => window.request_redraw(),
            _ => {}
        }
    });
}
