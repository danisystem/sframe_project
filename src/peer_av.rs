use anyhow::{anyhow, Result};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use bytemuck;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use image::{codecs::jpeg::JpegEncoder, ColorType, GenericImageView, RgbImage};
use nokhwa::pixel_format::RgbFormat;
use nokhwa::utils::{
    ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
};
use nokhwa::{query, Camera};
use pixels::{Pixels, SurfaceTexture};
use sframe::header::SframeHeader;
use sframe::CipherSuite;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoop};
use winit::window::WindowBuilder;

mod sender;
mod receiver;
use receiver::Receiver;
use sender::Sender;

// ─────────────────────────── Framing ───────────────────────────
const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

fn write_u32_le(mut w: impl Write, v: u32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
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
fn send_frame(stream: &Arc<Mutex<TcpStream>>, sid: u8, pkt: &[u8]) -> std::io::Result<()> {
    let mut s = stream.lock().unwrap();
    s.write_all(&[sid])?;
    write_u32_le(&mut *s, u32::try_from(pkt.len()).unwrap())?;
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

// scelta formato camera (preferenza MJPEG > YUYV > NV12, poi distanza da W/H/FPS)
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
            FrameFormat::NV12 => 2,
            _ => 3,
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

// ─────────────────────────── YUV → RGB ───────────────────────────
#[inline]
fn clamp8(x: i32) -> u8 {
    if x < 0 {
        0
    } else if x > 255 {
        255
    } else {
        x as u8
    }
}

// YUYV 4:2:2 → RGB24
fn yuyv422_to_rgb24(yuyv: &[u8], rgb: &mut [u8], w: usize, h: usize) -> bool {
    if yuyv.len() < w * h * 2 || rgb.len() < w * h * 3 {
        return false;
    }
    let mut si = 0;
    let mut di = 0;
    for _ in 0..h {
        for _ in (0..w).step_by(2) {
            if si + 3 >= yuyv.len() || di + 5 >= rgb.len() {
                return false;
            }
            let y0 = yuyv[si] as i32;
            let u = yuyv[si + 1] as i32 - 128;
            let y1 = yuyv[si + 2] as i32;
            let v = yuyv[si + 3] as i32 - 128;
            si += 4;

            let r_v = (91881 * v) >> 16;
            let g_uv = (-22554 * u - 46802 * v) >> 16;
            let b_u = (116130 * u) >> 16;

            let r0 = clamp8(y0 + r_v);
            let g0 = clamp8(y0 + g_uv);
            let b0 = clamp8(y0 + b_u);

            let r1 = clamp8(y1 + r_v);
            let g1 = clamp8(y1 + g_uv);
            let b1 = clamp8(y1 + b_u);

            rgb[di] = r0;
            rgb[di + 1] = g0;
            rgb[di + 2] = b0;
            rgb[di + 3] = r1;
            rgb[di + 4] = g1;
            rgb[di + 5] = b1;
            di += 6;
        }
    }
    true
}

// NV12 4:2:0 → RGB24
fn nv12_to_rgb24(nv12: &[u8], rgb: &mut [u8], w: usize, h: usize) -> bool {
    let y_size = w * h;
    let uv_size = y_size / 2;
    if nv12.len() < y_size + uv_size || rgb.len() < w * h * 3 {
        return false;
    }
    let y_plane = &nv12[..y_size];
    let uv_plane = &nv12[y_size..y_size + uv_size];

    let mut di = 0;
    for j in 0..h {
        let y_row = &y_plane[j * w..(j + 1) * w];
        let uv_row = &uv_plane[(j / 2) * w..(j / 2 + 1) * w];
        for i in 0..w {
            let y = y_row[i] as i32;
            let u = uv_row[i & !1] as i32 - 128;
            let v = uv_row[(i & !1) + 1] as i32 - 128;

            let r_v = (91881 * v) >> 16;
            let g_uv = (-22554 * u - 46802 * v) >> 16;
            let b_u = (116130 * u) >> 16;

            rgb[di] = clamp8(y + r_v);
            rgb[di + 1] = clamp8(y + g_uv);
            rgb[di + 2] = clamp8(y + b_u);
            di += 3;
        }
    }
    true
}

// ─────────────────────────── Main ───────────────────────────
//
// USO:
//   peer_av --role server --bind 0.0.0.0:7000 [OPZIONI]
//   peer_av --role client --connect 192.168.1.23:7000 [OPZIONI]
//
// OPZIONI principali:
//   --key-audio KA --key-video KV --secret S --suite SUITE --inspect
//   --device N --width W --height H --fps F --quality Q --list
//   --send-audio 0/1 --send-video 0/1 --recv-audio 0/1 --recv-video 0/1
//
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if has_flag(&args, "--help") || (!has_flag(&args, "--role")) {
        eprintln!(
            "Uso:\n  peer_av --role server --bind 0.0.0.0:7000 [OPZIONI]\n  peer_av --role client --connect HOST:PORT [OPZIONI]\n  --list (elenco camere e uscita)"
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
        parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512"))
            .unwrap_or(CipherSuite::AesGcm256Sha512);
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

    // SFrame
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

    // TCP
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

    // ───────────── AUDIO OUT ─────────────
    let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);
    let host = cpal::default_host();
let out_dev = host
    .default_output_device()
    .ok_or_else(|| anyhow::anyhow!("no default output device"))?;

// Qui out_cfg è un SupportedStreamConfig (non più Result)
let out_cfg: cpal::SupportedStreamConfig = out_dev.default_output_config()?;

// Leggi i parametri una volta
let out_sample_format = out_cfg.sample_format();
let out_sample_rate = out_cfg.sample_rate().0 as usize;
let out_channels = out_cfg.channels() as usize;

eprintln!(
    "[peer][audio-out] {:?} {}Hz {}ch",
    out_sample_format, out_sample_rate, out_channels
);

let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);
let mut pending: Vec<i16> = Vec::new();
let err_fn = |e| eprintln!("[peer][audio-out] err: {e}");

let out_stream = match out_sample_format {
    cpal::SampleFormat::I16 => out_dev.build_output_stream(
        &out_cfg.clone().into(),            // <-- usa clone().into()
        move |out: &mut [i16], _| {
            // ... tuo callback invariato ...
        },
        err_fn,
        None,
    )?,
    cpal::SampleFormat::U16 => out_dev.build_output_stream(
        &out_cfg.clone().into(),
        move |out: &mut [u16], _| {
            // ... callback U16 ...
        },
        err_fn,
        None,
    )?,
    cpal::SampleFormat::F32 => out_dev.build_output_stream(
        &out_cfg.clone().into(),
        move |out: &mut [f32], _| {
            // ... callback F32 ...
        },
        err_fn,
        None,
    )?,
    _ => anyhow::bail!("Formato out non gestito"),
};

out_stream.play()?;

    // ───────────── VIDEO OUT (window) ─────────────
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("SFrame A/V — ESC per uscire")
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
        .expect("window");
    let window_size = window.inner_size();
    let surface_texture = SurfaceTexture::new(window_size.width, window_size.height, &window);
    let mut pixels = Pixels::new(640, 480, surface_texture)?;

    let fb_video: Arc<Mutex<(usize, usize, Vec<u8>)>> =
        Arc::new(Mutex::new((640, 480, vec![0u8; 640 * 480 * 4])));

    // ───────────── RECV thread ─────────────
    {
        let stream_rx = Arc::clone(&stream);
        let fb_video = Arc::clone(&fb_video);
        let mut r_audio = r_audio;
        let mut r_video = r_video;
        thread::spawn(move || {
            let mut buf = Vec::new();
            let mut tcp = stream_rx.lock().unwrap().try_clone().expect("clone tcp");
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
                        match image::load_from_memory(plain) {
                            Ok(dynimg) => {
                                let rgba = dynimg.to_rgba8();
                                let (w, h) = (rgba.width() as usize, rgba.height() as usize);
                                let mut fb = fb_video.lock().unwrap();
                                fb.0 = w;
                                fb.1 = h;
                                fb.2 = rgba.into_raw();
                            }
                            Err(e) => {
                                eprintln!("[peer][video] decode err: {e}");
                                continue;
                            }
                        }
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
            // probe
            let req_probe = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
            let mut cam =
                Camera::new(CameraIndex::Index(device), req_probe).expect("open cam (probe)");
            let fmts = cam.compatible_camera_formats().expect("fmts");
            let best =
                pick_best_format(&fmts, want_w, want_h, want_fps).expect("pick format");
            let use_w = best.resolution().width();
            let use_h = best.resolution().height();
            let use_fps = best.frame_rate();
            eprintln!(
                "[peer][video-in] richiesto ~{}x{}@{}; scelto {}x{}@{} {:?}",
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
            let (w, h) = (use_w as usize, use_h as usize);

            let mut rgb = vec![0u8; w * h * 3];
            let mut jpeg_buf: Vec<u8> = Vec::with_capacity(256 * 1024);

            loop {
                let f = match cam.frame() {
                    Ok(fr) => fr,
                    Err(e) => {
                        eprintln!("[peer][video-in] frame err: {e}");
                        continue;
                    }
                };
                let src_fmt = f.source_frame_format();
                let src = f.buffer();

                let ok = match src_fmt {
                    FrameFormat::MJPEG => {
                        match image::load_from_memory(src) {
                            Ok(dynimg) => {
                                let rgb8 = dynimg.to_rgb8();
                                if rgb8.width() as usize != w || rgb8.height() as usize != h {
                                    eprintln!(
                                        "[peer][video-in] size mismatch mjpeg {}x{} != {}x{}",
                                        rgb8.width(),
                                        rgb8.height(),
                                        w,
                                        h
                                    );
                                    false
                                } else {
                                    rgb.copy_from_slice(&rgb8);
                                    true
                                }
                            }
                            Err(e) => {
                                eprintln!("[peer][video-in] mjpeg decode err: {e}");
                                false
                            }
                        }
                    }
                    FrameFormat::YUYV => yuyv422_to_rgb24(src, &mut rgb, w, h),
                    FrameFormat::NV12 => nv12_to_rgb24(src, &mut rgb, w, h),
                    other => {
                        eprintln!("[peer][video-in] unsupported camera fmt: {:?}", other);
                        false
                    }
                };
                if !ok {
                    continue;
                }

                jpeg_buf.clear();
                let mut enc = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
                if let Err(e) =
                    enc.encode(&rgb, use_w, use_h, ColorType::Rgb8)
                {
                    eprintln!("[peer][video-in] jpeg err: {e}");
                    continue;
                }

                let pkt = match s_video_tx.encrypt_frame(&jpeg_buf) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[peer][video-in] sframe err: {e:?}");
                        continue;
                    }
                };
                if inspect && (n % 30 == 0) {
                    inspect_packet("[TX][VID]", pkt);
                }
                if let Err(e) = send_frame(&stream_tx, SID_VIDEO, pkt) {
                    eprintln!("[peer][video-in] send err: {e}");
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

    // ───────────── AUDIO IN (capture+encrypt) ─────────────
    if send_audio {
        let stream_tx = Arc::clone(&stream);
        let mut s_audio_tx = s_audio_tx;
        thread::spawn(move || {
            let host = cpal::default_host();
            let dev = host
                .default_input_device()
                .expect("no default input device");
            let config = dev.default_input_config().expect("no default input config");
            let sample_rate = config.sample_rate().0 as usize;
            let channels = config.channels() as usize;
            eprintln!(
                "[peer][audio-in] {:?} {:?}Hz {}ch",
                config.sample_format(),
                sample_rate,
                channels
            );
            let chunk_frames = (sample_rate / 50).max(1); // ~20ms
            let mut acc_i16: Vec<i16> = Vec::with_capacity(chunk_frames * channels);
            let err_fn = |e| eprintln!("[peer][audio-in] err: {e}");
            let stream_in = match config.sample_format() {
                cpal::SampleFormat::I16 => dev
                    .build_input_stream(
                        &config.clone().into(),
                        move |data: &[i16], _| {
                            acc_i16.extend_from_slice(data);
                            if acc_i16.len() >= chunk_frames * channels {
                                let pkt = match s_audio_tx
                                    .encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[peer][audio-in] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream_tx, SID_AUDIO, pkt) {
                                    eprintln!("[peer][audio-in] send err: {e}");
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
                                let pkt = match s_audio_tx
                                    .encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[peer][audio-in] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream_tx, SID_AUDIO, pkt) {
                                    eprintln!("[peer][audio-in] send err: {e}");
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
                                let v = (x * i16::MAX as f32)
                                    .clamp(i16::MIN as f32, i16::MAX as f32);
                                v as i16
                            }));
                            if acc_i16.len() >= chunk_frames * channels {
                                let pkt = match s_audio_tx
                                    .encrypt_frame(bytemuck::cast_slice(&acc_i16))
                                {
                                    Ok(p) => p,
                                    Err(e) => {
                                        eprintln!("[peer][audio-in] sframe err: {e:?}");
                                        acc_i16.clear();
                                        return;
                                    }
                                };
                                if let Err(e) = send_frame(&stream_tx, SID_AUDIO, pkt) {
                                    eprintln!("[peer][audio-in] send err: {e}");
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

    // ───────────── Event loop ─────────────
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
                let (w, h, buf) = {
                    let fb = fb_video.lock().unwrap();
                    (fb.0, fb.1, fb.2.clone())
                };
                if w > 0 && h > 0 && buf.len() == w * h * 4 {
                    pixels.resize_surface(w as u32, h as u32);
                    pixels.resize_buffer(w as u32, h as u32);
                    pixels.frame_mut().copy_from_slice(&buf);
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
