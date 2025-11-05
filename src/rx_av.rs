use anyhow::Result;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::num::NonZeroU32;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use image::GenericImageView;
use sframe::header::SframeHeader;
use sframe::CipherSuite;

use softbuffer::Context;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoop};
use winit::window::WindowBuilder;

mod receiver;
use receiver::Receiver;

// ---------- framing ----------
const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

fn read_exact_u32(mut r: impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn recv_frame<'a>(
    s: &mut TcpStream,
    buf: &'a mut Vec<u8>,
) -> std::io::Result<(u8, &'a [u8])> {
    let mut sid = [0u8; 1];
    s.read_exact(&mut sid)?;
    let len = read_exact_u32(&mut *s)?; // reborrow per non muovere s
    buf.resize(len as usize, 0);
    s.read_exact(buf)?;
    Ok((sid[0], &buf[..]))
}

// ---------- inspect helpers ----------
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

fn inspect_packet_verbose(prefix: &str, packet: &[u8]) {
    match SframeHeader::deserialize(packet) {
        Ok(h) => {
            let hdr_len = h.len();
            let body_len = packet.len().saturating_sub(hdr_len);
            let header = &packet[..hdr_len];
            let body = &packet[hdr_len..];

            let (ct_len, tag_len) = if body_len >= 16 { (body_len - 16, 16) } else { (body_len, 0) };
            let (tag_hex, ct_preview_hex) = if tag_len == 16 {
                let tag = &body[body_len - 16..];
                // preview (opzionale) dei primi 8 byte del ciphertext, NON l'intero
                let ct_preview = &body[..ct_len.min(8)];
                (hex::encode(tag), hex::encode(ct_preview))
            } else {
                (String::from(""), String::from(""))
            };

            println!("┌─ {prefix} SFrame Packet ───────────────────────────────");
            println!("│ Header struct  : {h}");
            println!("│ Header len     : {hdr_len} bytes (AAD)");
            println!("│ Header HEX     : {}", hex::encode(header));
            println!("│ Header BIN     : {}", bytes_to_bin(header));
            println!("│ KeyId (kid)    : {}", h.key_id());
            println!("│ Counter (ctr)  : {}", h.counter());
            println!("│ AAD(bytes)     : {}", hdr_len);
            println!("│ CT(bytes)      : {ct_len}");
            println!("│ TAG(bytes)     : {tag_len}");
            println!("│ Total bytes    : {}", packet.len());
            if tag_len == 16 {
                println!("│ GCM TAG (HEX)  : {tag_hex}");
            }
            if ct_len > 0 {
                println!("│ CT preview     : {}{}",
                         ct_preview_hex,
                         if ct_len > 8 { "… (troncato)" } else { "" });
            }
            println!("│ Nonce / IV     : derivato internamente da SFrame (non serializzato, non esposto)");
            println!("└────────────────────────────────────────────────────────");
        }
        Err(e) => eprintln!("[inspect] errore header: {e:?}"),
    }
}

// ---------- args ----------
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

fn main() -> Result<()> {
    // USO:
    // rx_av <BIND:PORT> [--key-audio KA] [--key-video KV] [--secret S] [--suite SUITE] [--inspect]
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 || has_flag(&args, "--help") {
        eprintln!("Uso: rx_av <BIND:PORT> [--key-audio KA] [--key-video KV] [--secret S] [--suite SUITE] [--inspect]");
        return Ok(());
    }
    let bind = &args[1];
    let key_audio = read_flag_u64(&args, "--key-audio", 1);
    let key_video = read_flag_u64(&args, "--key-video", 2);
    let secret = read_flag_str(&args, "--secret", "SUPER_SECRET");
    let suite = parse_suite(read_flag_str(&args, "--suite", "aes-gcm256-sha512"))
        .unwrap_or(CipherSuite::AesGcm256Sha512);
    let inspect = has_flag(&args, "--inspect");

    // Receivers SFrame (senza frame validation ⇒ Send OK)
    let mut r_audio = Receiver::from(receiver::ReceiverOptions {
        cipher_suite: suite,
        n_ratchet_bits: None,
    });
    r_audio.set_encryption_key(key_audio, secret.as_bytes())?;
    let mut r_video = Receiver::from(receiver::ReceiverOptions {
        cipher_suite: suite,
        n_ratchet_bits: None,
    });
    r_video.set_encryption_key(key_video, secret.as_bytes())?;

    // listener TCP
    let listener = TcpListener::bind(bind)?;
    println!("[rx_av] listening on {}", bind);
    let (mut stream, peer) = listener.accept()?;
    stream.set_nodelay(true)?;
    println!("[rx_av] connected: {}", peer);

    // ----------------- Audio output (cpal) -----------------
    let host = cpal::default_host();
    let out_dev = host
        .default_output_device()
        .expect("no default output device");
    let out_cfg = out_dev
        .default_output_config()
        .expect("no default output config");

    let out_sample_rate = out_cfg.sample_rate().0 as usize;
    let out_channels = out_cfg.channels() as usize;
    eprintln!(
        "[rx_av][audio] output {:?} {:?}Hz {}ch",
        out_cfg.sample_format(),
        out_sample_rate,
        out_channels
    );

    // canale per campioni i16 (interleaved) dal thread rete
    let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);

    // render: callback
    let mut pending: Vec<i16> = Vec::new();
    let err_fn = |e| eprintln!("[rx_av][audio] out err: {e}");
    let out_stream = match out_cfg.sample_format() {
        cpal::SampleFormat::I16 => out_dev
            .build_output_stream(
                &out_cfg.clone().into(),
                move |out: &mut [i16], _| {
                    let mut idx = 0;
                    while idx < out.len() {
                        if pending.is_empty() {
                            if let Ok(mut next) = rx_pcm.try_recv() {
                                pending.append(&mut next);
                            } else {
                                for s in &mut out[idx..] { *s = 0; }
                                break;
                            }
                        }
                        let n = (out.len() - idx).min(pending.len());
                        out[idx..idx + n].copy_from_slice(&pending[..n]);
                        pending.drain(..n);
                        idx += n;
                    }
                },
                err_fn, None,
            )?,
        cpal::SampleFormat::U16 => out_dev
            .build_output_stream(
                &out_cfg.clone().into(),
                move |out: &mut [u16], _| {
                    let mut idx = 0;
                    while idx < out.len() {
                        if pending.is_empty() {
                            if let Ok(mut next) = rx_pcm.try_recv() {
                                pending.append(&mut next);
                            } else {
                                for s in &mut out[idx..] { *s = 32768; }
                                break;
                            }
                        }
                        let n = (out.len() - idx).min(pending.len());
                        for i in 0..n { out[idx + i] = (pending[i] as i32 + 32768) as u16; }
                        pending.drain(..n);
                        idx += n;
                    }
                },
                err_fn, None,
            )?,
        cpal::SampleFormat::F32 => out_dev
            .build_output_stream(
                &out_cfg.clone().into(),
                move |out: &mut [f32], _| {
                    let mut idx = 0;
                    while idx < out.len() {
                        if pending.is_empty() {
                            if let Ok(mut next) = rx_pcm.try_recv() {
                                pending.append(&mut next);
                            } else {
                                for s in &mut out[idx..] { *s = 0.0; }
                                break;
                            }
                        }
                        let n = (out.len() - idx).min(pending.len());
                        for i in 0..n { out[idx + i] = pending[i] as f32 / i16::MAX as f32; }
                        pending.drain(..n);
                        idx += n;
                    }
                },
                err_fn, None,
            )?,
        _ => panic!("Formato out non gestito"),
    };
    out_stream.play()?;

    // ----------------- Video window (winit + softbuffer) -----------------
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("SFrame A/V — ESC per uscire")
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
        .expect("window");

    let ctx = unsafe { Context::new(&window).expect("softbuffer ctx") };
    let mut surface =
        unsafe { softbuffer::Surface::new(&ctx, &window).expect("softbuffer surface") };

    // framebuffer condiviso: (w, h, pixels 0x00RRGGBB)
    let fb_video: Arc<Mutex<(usize, usize, Vec<u32>)>> =
        Arc::new(Mutex::new((640, 480, vec![0u32; 640 * 480])));
    let fb_video_clone = fb_video.clone();

    // ----------------- Network reader thread -----------------
    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut tcp = stream; // possiede lo stream qui (mut!)
        let mut last_log = Instant::now();
        let mut r_audio = r_audio;
        let mut r_video = r_video;

        loop {
            let (sid, pkt) = match recv_frame(&mut tcp, &mut buf) {
                Ok(v) => v,
                Err(e) => { eprintln!("[rx_av] tcp read err: {e}"); break; }
            };

            if inspect {
                match sid {
                    SID_VIDEO => inspect_packet_verbose("[RX][VID]", pkt),
                    SID_AUDIO => inspect_packet_verbose("[RX][AUD]", pkt),
                    _ => inspect_packet_verbose("[RX][UNK]", pkt),
                }
            }

            match sid {
                SID_VIDEO => {
                    let plain = match r_video.decrypt_frame(pkt) {
                        Ok(p) => p,
                        Err(e) => { eprintln!("[rx_av][video] decrypt err: {e:?}"); continue; }
                    };
                    if last_log.elapsed() > Duration::from_secs(1) {
                        eprintln!("[rx_av][video] got frame {}B", plain.len());
                        last_log = Instant::now();
                    }
                    let img = match image::load_from_memory(plain) {
                        Ok(i) => i,
                        Err(e) => { eprintln!("[rx_av][video] decode err: {e}"); continue; }
                    };
                    let (w, h) = img.dimensions();
                    let rgb8 = img.to_rgb8();
                    let mut rgbx: Vec<u32> = Vec::with_capacity((w * h) as usize);
                    for px in rgb8.pixels() {
                        let [r, g, b] = px.0;
                        rgbx.push(((r as u32) << 16) | ((g as u32) << 8) | (b as u32));
                    }
                    let mut fb = fb_video_clone.lock().unwrap();
                    fb.0 = w as usize; fb.1 = h as usize; fb.2 = rgbx;
                }
                SID_AUDIO => {
                    let plain = match r_audio.decrypt_frame(pkt) {
                        Ok(p) => p,
                        Err(e) => { eprintln!("[rx_av][audio] decrypt err: {e:?}"); continue; }
                    };
                    if plain.len() % 2 != 0 {
                        eprintln!("[rx_av][audio] odd sample bytes, drop");
                        continue;
                    }
                    let slice_i16: &[i16] = bytemuck::cast_slice(plain);
                    let _ = tx_pcm.try_send(slice_i16.to_vec());
                }
                _ => eprintln!("[rx_av] unknown sid: {sid}"),
            }
        }
    });

    // --------------- Event loop ---------------
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

            Event::MainEventsCleared => {
                // chiede ridisegno ogni “tick”
                let _ = window.request_redraw();
            }

            Event::RedrawRequested(_) => {
                let (w, h, buf) = {
                    let fb = fb_video.lock().unwrap();
                    (fb.0, fb.1, fb.2.clone())
                };
                if w == 0 || h == 0 || buf.is_empty() { return; }

                // porta la window alla dimensione del video (se è cambiata)
                let size = window.inner_size();
                if size.width as usize != w || size.height as usize != h {
                    window.set_inner_size(LogicalSize::new(w as f64, h as f64));
                    let _ = surface.resize(
                        NonZeroU32::new(w as u32).unwrap(),
                        NonZeroU32::new(h as u32).unwrap(),
                    );
                }

                if let Ok(mut surface_buf) = surface.buffer_mut() {
                    surface_buf.copy_from_slice(&buf);
                    let _ = surface_buf.present();
                }
            }
            _ => {}
        }
    });
}
