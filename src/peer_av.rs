// src/peer_av.rs
use anyhow::{anyhow, Result};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use bytemuck;
use image::GenericImageView;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use image::{codecs::jpeg::JpegEncoder, ColorType};
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
    Resolution,
};
use nokhwa::{query, Camera};
use pixels::{Pixels, SurfaceTexture};
use sframe::header::SframeHeader;
use sframe::CipherSuite;
use winit::{
    dpi::LogicalSize,
    event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};

mod sender;
mod receiver;
use receiver::Receiver;
use sender::Sender;

// ─────────────────────────── Framing ───────────────────────────
const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

fn write_u32_le(mut w: impl Write, n: u32) -> std::io::Result<()> {
    w.write_all(&n.to_le_bytes())
}
fn read_u32_le(mut r: impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

// len-prefixed frame: [sid:1][len:4][bytes:len]
fn recv_frame<'a>(s: &mut TcpStream, buf: &'a mut Vec<u8>) -> std::io::Result<(u8, &'a [u8])> {
    let mut sid = [0u8; 1];
    s.read_exact(&mut sid)?;
    let len = read_u32_le(&mut *s)?;
    buf.resize(len as usize, 0);
    s.read_exact(buf)?;
    Ok((sid[0], &buf[..]))
}
fn send_frame(stream: &Arc<Mutex<TcpStream>>, sid: u8, pkt: &[u8]) -> std::io::Result<()> {
    let mut s = stream.lock().unwrap();
    s.write_all(&[sid])?;
    write_u32_le(&mut *s, pkt.len() as u32)?;
    s.write_all(pkt)?;
    Ok(())
}

// ─────────────────────────── Helpers ───────────────────────────
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
fn read_flag_u64(args: &[String], name: &str, def: u64) -> u64 {
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

fn inspect_packet(prefix: &str, packet: &[u8]) {
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

// preferenze formato camera + picking
fn pick_best_format(
    formats: &[CameraFormat],
    want_w: u32,
    want_h: u32,
    want_fps: u32,
) -> Option<CameraFormat> {
    fn score(fmt: &CameraFormat, want_w: u32, want_h: u32, want_fps: u32) -> (u32, u32, u32, u32) {
        let res = fmt.resolution();
        let (w, h, fps) = (res.width(), res.height(), fmt.frame_rate());
        #[cfg(target_os = "macos")]
        let pref = match fmt.format() {
            FrameFormat::YUYV => 0,
            FrameFormat::MJPEG => 1,
            _ => 2,
        };
        #[cfg(not(target_os = "macos"))]
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

// ─────────────────────────── Main ───────────────────────────
// USO:
//   peer_av --role server --bind 0.0.0.0:7000 [OPZIONI]
//   peer_av --role client --connect HOST:PORT [OPZIONI]
// OPZIONI:
//   --list            (lista camere e formati)
//   --device N --width W --height H --fps F --quality Q
//   --key-audio KA --key-video KV --secret S --suite SUITE --inspect
//   --send-audio 0/1 --send-video 0/1 --recv-audio 0/1 --recv-video 0/1
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if has_flag(&args, "--help") || !has_flag(&args, "--role") {
        eprintln!(
"Uso:
  peer_av --role server --bind 0.0.0.0:7000 [OPZIONI]
  peer_av --role client --connect HOST:PORT [OPZIONI]
  --list          Elenca camere e formati disponibili
Opzioni principali:
  --device N --width W --height H --fps F --quality Q
  --key-audio KA --key-video KV --secret S --suite aes-gcm256-sha512 --inspect
  --send-audio 0/1 --send-video 0/1 --recv-audio 0/1 --recv-video 0/1"
        );
        return Ok(());
    }

    let role = read_flag_str(&args, "--role", "client"); // server|client
    let bind = read_flag_str(&args, "--bind", "0.0.0.0:7000");
    let connect = read_flag_str(&args, "--connect", "127.0.0.1:7000");
    let list = has_flag(&args, "--list");

    // Video desiderato
    let device = read_flag_u32(&args, "--device", 0);
    let want_w = read_flag_u32(&args, "--width", 640);
    let want_h = read_flag_u32(&args, "--height", 480);
    let want_fps = read_flag_u32(&args, "--fps", 30);
    let quality = read_flag_u32(&args, "--quality", 70) as u8;

    // Crypto
    let key_audio = read_flag_u64(&args, "--key-audio", 1);
    let key_video = read_flag_u64(&args, "--key-video", 2);
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite =
        parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512")).unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");

    // Abilitazioni
    let send_audio = read_flag_u32(&args, "--send-audio", 1) != 0;
    let send_video = read_flag_u32(&args, "--send-video", 1) != 0;
    let recv_audio = read_flag_u32(&args, "--recv-audio", 1) != 0;
    let recv_video = read_flag_u32(&args, "--recv-video", 1) != 0;

    // Solo lista camere
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

    // Costruisci SFrame sender/receiver
    let mut s_audio_tx = Sender::with_cipher_suite(key_audio, suite);
    s_audio_tx.set_encryption_key(secret.as_bytes())?;
    let mut s_video_tx = Sender::with_cipher_suite(key_video, suite);
    s_video_tx.set_encryption_key(secret.as_bytes())?;

    let mut r_audio =
        Receiver::from(receiver::ReceiverOptions { cipher_suite: suite, n_ratchet_bits: None });
    r_audio.set_encryption_key(key_audio, secret.as_bytes())?;
    let mut r_video =
        Receiver::from(receiver::ReceiverOptions { cipher_suite: suite, n_ratchet_bits: None });
    r_video.set_encryption_key(key_video, secret.as_bytes())?;

    // TCP setup
    let stream = match role.to_ascii_lowercase().as_str() {
        "server" => {
            let listener = TcpListener::bind(bind)?;
            println!("[peer] listening on {}", bind);
            let (s, peer) = listener.accept()?;
            s.set_nodelay(true)?;
            println!("[peer] connected: {}", peer);
            Arc::new(Mutex::new(s))
        }
        _ => {
            let s = TcpStream::connect(connect)?;
            s.set_nodelay(true)?;
            println!("[peer] connected {}", connect);
            Arc::new(Mutex::new(s))
        }
    };

    // ───────────── AUDIO OUT (player) ─────────────
    let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);
    let host = cpal::default_host();
    let out_dev = host
        .default_output_device()
        .ok_or_else(|| anyhow!("no default output device"))?;
    let out_cfg = out_dev
        .default_output_config()
        .map_err(|_| anyhow!("no default output config"))?;
    eprintln!(
        "[peer][audio-out] {:?} {:?}Hz {}ch",
        out_cfg.sample_format(),
        out_cfg.sample_rate().0,
        out_cfg.channels()
    );

    let mut pending: Vec<i16> = Vec::new();
    let err_fn = |e| eprintln!("[peer][audio-out] err: {e}");
    let out_stream = match out_cfg.sample_format() {
        cpal::SampleFormat::I16 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [i16], _| {
                if !recv_audio {
                    for s in out {
                        *s = 0;
                    }
                    return;
                }
                let mut idx = 0;
                while idx < out.len() {
                    if pending.is_empty() {
                        if let Ok(mut next) = rx_pcm.try_recv() {
                            pending.append(&mut next);
                        } else {
                            for s in &mut out[idx..] {
                                *s = 0;
                            }
                            break;
                        }
                    }
                    let n = (out.len() - idx).min(pending.len());
                    out[idx..idx + n].copy_from_slice(&pending[..n]);
                    pending.drain(..n);
                    idx += n;
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::F32 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [f32], _| {
                if !recv_audio {
                    for s in out {
                        *s = 0.0;
                    }
                    return;
                }
                let mut idx = 0;
                while idx < out.len() {
                    if pending.is_empty() {
                        if let Ok(mut next) = rx_pcm.try_recv() {
                            pending.append(&mut next);
                        } else {
                            for s in &mut out[idx..] {
                                *s = 0.0;
                            }
                            break;
                        }
                    }
                    let n = (out.len() - idx).min(pending.len());
                    for i in 0..n {
                        out[idx + i] = pending[i] as f32 / i16::MAX as f32;
                    }
                    pending.drain(..n);
                    idx += n;
                }
            },
            err_fn,
            None,
        )?,
        cpal::SampleFormat::U16 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [u16], _| {
                if !recv_audio {
                    for s in out {
                        *s = 32768;
                    }
                    return;
                }
                let mut idx = 0;
                while idx < out.len() {
                    if pending.is_empty() {
                        if let Ok(mut next) = rx_pcm.try_recv() {
                            pending.append(&mut next);
                        } else {
                            for s in &mut out[idx..] {
                                *s = 32768;
                            }
                            break;
                        }
                    }
                    let n = (out.len() - idx).min(pending.len());
                    for i in 0..n {
                        out[idx + i] = (pending[i] as i32 + 32768) as u16;
                    }
                    pending.drain(..n);
                    idx += n;
                }
            },
            err_fn,
            None,
        )?,
        _ => panic!("Formato out non gestito"),
    };
    out_stream.play()?;

    // ───────────── VIDEO OUT (window) ─────────────
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("SFrame A/V — ESC per uscire")
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
        .unwrap();
    let window_size = window.inner_size();
    let surface_texture = SurfaceTexture::new(window_size.width, window_size.height, &window);
    let mut pixels = Pixels::new(640, 480, surface_texture)?;

    let fb_video: Arc<Mutex<(usize, usize, Vec<u8>)>> =
        Arc::new(Mutex::new((640, 480, vec![0u8; 640 * 480 * 4])));

    // ───────────── RECV thread (read+decrypt) ─────────────
    {
        let stream_rx = Arc::clone(&stream);
        let fb_video = Arc::clone(&fb_video);
        let mut r_audio = r_audio;
        let mut r_video = r_video;
        thread::spawn(move || {
            let mut buf = Vec::new();
            let mut tcp = stream_rx.lock().unwrap().try_clone().expect("clone tcp");
            let mut last_log = Instant::now();

            loop {
                let (sid, pkt) = match recv_frame(&mut tcp, &mut buf) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[peer][rx] tcp err: {e}");
                        break;
                    }
                };
                if inspect {
                    match sid {
                        SID_VIDEO => inspect_packet("[RX][VID]", pkt),
                        SID_AUDIO => inspect_packet("[RX][AUD]", pkt),
                        _ => inspect_packet("[RX][UNK]", pkt),
                    }
                }
                match sid {
                    SID_VIDEO if recv_video => {
                        let plain = match r_video.decrypt_frame(pkt) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("[peer][video] decrypt err: {e:?}");
                                continue;
                            }
                        };
                        if last_log.elapsed() > Duration::from_secs(1) {
                            eprintln!("[peer][video] got frame {}B", plain.len());
                            last_log = Instant::now();
                        }
                        let dynimg = match image::load_from_memory(plain) {
                            Ok(i) => i,
                            Err(e) => {
                                eprintln!("[peer][video] decode err: {e}");
                                continue;
                            }
                        };
                        let (w, h) = dynimg.dimensions();
                        let rgba = dynimg.to_rgba8();
                        let mut fb = fb_video.lock().unwrap();
                        fb.0 = w as usize;
                        fb.1 = h as usize;
                        fb.2 = rgba.into_raw();
                    }
                    SID_AUDIO if recv_audio => {
                        let plain = match r_audio.decrypt_frame(pkt) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("[peer][audio] decrypt err: {e:?}");
                                continue;
                            }
                        };
                        if plain.len() % 2 != 0 {
                            eprintln!("[peer][audio] odd sample bytes, drop");
                            continue;
                        }
                        let slice_i16: &[i16] = bytemuck::cast_slice(plain);
                        let _ = tx_pcm.try_send(slice_i16.to_vec());
                    }
                    _ => {}
                }
            }
        });
    }

    // ───────────── VIDEO IN (capture+encrypt) ─────────────
    if send_video {
        let stream_tx = Arc::clone(&stream);
        let mut s_video_tx = s_video_tx;
        thread::spawn(move || {
    // helper locale che *ritorna* Result, lo usiamo con .ok()
    fn open_camera_exact(device: u32, fmt: CameraFormat) -> Result<(u32,u32,u32,CameraFormat, Camera)> {
        let req = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Exact(fmt.clone()));
        let mut c = Camera::new(CameraIndex::Index(device), req)?;
        let res = c.camera_format().resolution();
        Ok((res.width(), res.height(), c.camera_format().frame_rate(), c.camera_format().clone(), c))
    }

    // 1) probe formati
    let req_loose = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
    let mut cam = match Camera::new(CameraIndex::Index(device), req_loose) {
        Ok(c) => c,
        Err(e) => { eprintln!("[peer][video-in] open cam (loose) failed: {e}"); return; }
    };
    let fmts = cam.compatible_camera_formats().unwrap_or_default();
    drop(cam);

    // 2) scelgo formato: best → fallback YUYV 640x480@30 → 1280x720@30
    let mut chosen: Option<(u32,u32,u32,CameraFormat,Camera)> = None;
    if let Some(fmt) = pick_best_format(&fmts, want_w, want_h, want_fps) {
        if let Ok(v) = open_camera_exact(device, fmt) { chosen = Some(v); }
    }
    if chosen.is_none() {
        let f1 = CameraFormat::new(Resolution::new(640, 480), FrameFormat::YUYV, 30);
        if let Ok(v) = open_camera_exact(device, f1) { chosen = Some(v); }
    }
    if chosen.is_none() {
        let f2 = CameraFormat::new(Resolution::new(1280, 720), FrameFormat::YUYV, 30);
        if let Ok(v) = open_camera_exact(device, f2) { chosen = Some(v); }
    }
    let (use_w, use_h, use_fps, chosen_fmt, mut cam) = match chosen {
        Some(v) => v,
        None => { eprintln!("[peer][video-in] nessun formato apribile"); return; }
    };

    eprintln!(
        "[peer][video-in] richiesto ~{}x{}@{}; scelto {}x{}@{} {:?}",
        want_w, want_h, want_fps, use_w, use_h, use_fps, chosen_fmt.format()
    );

    if let Err(e) = cam.open_stream() {
        eprintln!("[peer][video-in] open_stream err: {e}");
        return;
    }

    let frame_dt = Duration::from_millis((1000 / use_fps.max(1)) as u64);
    let mut last = Instant::now();
    let mut n: usize = 0;
    let mut jpeg_buf: Vec<u8> = Vec::with_capacity((use_w * use_h / 2) as usize);

    loop {
        let rgb = match cam.frame() {
            Ok(f) => match f.decode_image::<RgbFormat>() {
                Ok(v) => v,
                Err(e) => { eprintln!("[peer][video-in] decode_image err: {e}"); continue; }
            },
            Err(e) => { eprintln!("[peer][video-in] frame err: {e}"); continue; }
        };
        if rgb.len() != (use_w as usize * use_h as usize * 3) {
            eprintln!("[peer][video-in] size mismatch (got {}, want {})",
                      rgb.len(), use_w as usize * use_h as usize * 3);
            continue;
        }

        jpeg_buf.clear();
        let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
        if let Err(e) = enc.encode(&rgb, use_w, use_h, ColorType::Rgb8) {
            eprintln!("[peer][video-in] jpeg err: {e}");
            continue;
        }

        let pkt = match s_video_tx.encrypt_frame(&jpeg_buf) {
            Ok(p) => p,
            Err(e) => { eprintln!("[peer][video-in] sframe err: {e:?}"); continue; }
        };
        if inspect && (n % 30 == 0) { inspect_packet("[TX][VID]", pkt); }

        if let Err(e) = send_frame(&stream_tx, SID_VIDEO, pkt) {
            eprintln!("[peer][video-in] send err: {e}");
            break;
        }

        n = n.wrapping_add(1);
        let elapsed = last.elapsed();
        if elapsed < frame_dt { thread::sleep(frame_dt - elapsed); }
        last = Instant::now();
    }
});
    }

    // ───────────── AUDIO IN (capture+encrypt) ─────────────
    if send_audio {
        let stream_tx = Arc::clone(&stream);
        let mut s_audio_tx = s_audio_tx;
        thread::spawn(move || {
            let host = cpal::default_host();
            let dev = match host.default_input_device() {
                Some(d) => d,
                None => {
                    eprintln!("[peer][audio-in] no default input device");
                    return;
                }
            };
            let config = match dev.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[peer][audio-in] no default input config: {e}");
                    return;
                }
            };
            let sample_rate = config.sample_rate().0 as usize;
            let channels = config.channels() as usize;
            eprintln!(
                "[peer][audio-in] {:?} {:?}Hz {}ch",
                config.sample_format(),
                sample_rate,
                channels
            );

            // invia circa ogni ~20ms
            let chunk_frames = (sample_rate / 50).max(1);
            let mut acc_i16: Vec<i16> = Vec::with_capacity(chunk_frames * channels);
            let err_fn = |e| eprintln!("[peer][audio-in] err: {e}");

            let stream_in = match config.sample_format() {
                cpal::SampleFormat::I16 => dev
                    .build_input_stream(
                        &config.clone().into(),
                        move |data: &[i16], _| {
                            acc_i16.extend_from_slice(data);
                            if acc_i16.len() >= chunk_frames * channels {
                                if let Ok(pkt) =
                                    s_audio_tx.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    let _ = send_frame(&stream_tx, SID_AUDIO, pkt);
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
                            acc_i16.extend(data.iter().map(|&x| (x as i32 - 32768) as i16));
                            if acc_i16.len() >= chunk_frames * channels {
                                if let Ok(pkt) =
                                    s_audio_tx.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    let _ = send_frame(&stream_tx, SID_AUDIO, pkt);
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
                        &config.clone().into(),
                        move |data: &[f32], _| {
                            acc_i16.extend(data.iter().map(|&x| {
                                let v = (x * i16::MAX as f32)
                                    .clamp(i16::MIN as f32, i16::MAX as f32);
                                v as i16
                            }));
                            if acc_i16.len() >= chunk_frames * channels {
                                if let Ok(pkt) =
                                    s_audio_tx.encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    let _ = send_frame(&stream_tx, SID_AUDIO, pkt);
                                }
                                acc_i16.clear();
                            }
                        },
                        err_fn,
                        None,
                    )
                    .expect("build input F32"),
                _ => {
                    eprintln!("[peer][audio-in] formato non gestito");
                    return;
                }
            };
            if let Err(e) = stream_in.play() {
                eprintln!("[peer][audio-in] play err: {e}");
                return;
            }
            loop {
                thread::sleep(Duration::from_secs(3600));
            }
        });
    }

    // ───────────── Event loop (render + ESC/close) ─────────────
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;
        match event {
            Event::WindowEvent {
                event:
                    WindowEvent::CloseRequested
                    | WindowEvent::KeyboardInput {
                        input:
                            KeyboardInput {
                                virtual_keycode: Some(VirtualKeyCode::Escape),
                                state: ElementState::Pressed,
                                ..
                            },
                        ..
                    },
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::RedrawRequested(_) => {
                // copia frame video se attivo
                if recv_video {
                    let (w, h, buf) = {
                        let fb = fb_video.lock().unwrap();
                        (fb.0, fb.1, fb.2.clone())
                    };
                    if w > 0 && h > 0 && buf.len() == w * h * 4 {
                        pixels.resize_surface(w as u32, h as u32);
                        pixels.resize_buffer(w as u32, h as u32);
                        pixels.frame_mut().copy_from_slice(&buf);
                    }
                }
                if pixels.render().is_err() {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::MainEventsCleared => {
                window.request_redraw();
            }
            _ => {}
        }
    });
}
