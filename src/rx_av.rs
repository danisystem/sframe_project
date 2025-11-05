use anyhow::Result;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use image::GenericImageView;
use sframe::header::SframeHeader;
use sframe::CipherSuite;

use winit::{
    dpi::LogicalSize,
    event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use pixels::{Error, Pixels, SurfaceTexture};

mod receiver;
use receiver::Receiver;

const SID_VIDEO: u8 = 0x01;
const SID_AUDIO: u8 = 0x02;

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

fn has_flag(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
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

    let listener = TcpListener::bind(bind)?;
    println!("[rx_av] listening on {}", bind);
    let (mut stream, peer) = listener.accept()?;
    stream.set_nodelay(true)?;
    println!("[rx_av] connected: {}", peer);

    // AUDIO
    let host = cpal::default_host();
    let out_dev = host
        .default_output_device()
        .expect("no default output device");
    let out_cfg = out_dev.default_output_config().expect("no default output config");

    eprintln!(
        "[rx_av][audio] output {:?} {:?}Hz {}ch",
        out_cfg.sample_format(),
        out_cfg.sample_rate().0,
        out_cfg.channels()
    );

    let (tx_pcm, rx_pcm) = mpsc::sync_channel::<Vec<i16>>(32);
    let mut pending: Vec<i16> = Vec::new();
    let err_fn = |e| eprintln!("[rx_av][audio] out err: {e}");
    let out_stream = match out_cfg.sample_format() {
        cpal::SampleFormat::I16 => out_dev.build_output_stream(
            &out_cfg.clone().into(),
            move |out: &mut [i16], _| {
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

        _ => panic!("Formato out non gestito"),
    };

    out_stream.play()?;

    // VIDEO
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
    let fb_video_clone = fb_video.clone();

    thread::spawn(move || {
        let mut buf = Vec::new();
        let mut tcp = stream;
        let mut r_audio = r_audio;
        let mut r_video = r_video;

        loop {
            let (sid, pkt) = match recv_frame(&mut tcp, &mut buf) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[rx_av] tcp read err: {e}");
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
                SID_VIDEO => {
                    let plain = match r_video.decrypt_frame(pkt) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("[rx_av][video] decrypt err: {e:?}");
                            continue;
                        }
                    };
                    let img = match image::load_from_memory(plain) {
                        Ok(i) => i.to_rgba8(),
                        Err(e) => {
                            eprintln!("[rx_av][video] decode err: {e}");
                            continue;
                        }
                    };
                    let (w, h) = img.dimensions();
                    let mut fb = fb_video_clone.lock().unwrap();
                    fb.0 = w as usize;
                    fb.1 = h as usize;
                    fb.2 = img.into_raw();
                }
                SID_AUDIO => {
                    let plain = match r_audio.decrypt_frame(pkt) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("[rx_av][audio] decrypt err: {e:?}");
                            continue;
                        }
                    };
                    let slice_i16: &[i16] = bytemuck::cast_slice(plain);
                    let _ = tx_pcm.try_send(slice_i16.to_vec());
                }
                _ => eprintln!("[rx_av] unknown sid: {sid}"),
            }
        }
    });

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
            } => *control_flow = ControlFlow::Exit,

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

            Event::MainEventsCleared => window.request_redraw(),
            _ => {}
        }
    });
}
