use anyhow::Result;
use crossbeam_channel::{bounded, Sender as CbSender, Receiver as CbReceiver};
use std::{net::UdpSocket, time::Duration};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};

mod receiver;
use receiver::Receiver;

// ───────────────────────── Debug helpers (inspect) ─────────────────────────
use sframe::header::SframeHeader;
use hex;

fn bytes_to_bin(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 9);
    for (i, b) in bytes.iter().enumerate() {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:08b}");
        if i + 1 != bytes.len() { s.push(' '); }
    }
    s
}

fn inspect_packet_compact(packet: &[u8]) {
    match SframeHeader::deserialize(packet) {
        Ok(h) => {
            let header_len = h.len();
            let body_len = packet.len().saturating_sub(header_len);
            let (ct_len, tag_len) = if body_len >= 16 { (body_len - 16, 16) } else { (body_len, 0) };
            println!(
                "[RX][SFRAME] kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
                h.key_id(), h.counter(), header_len, ct_len, tag_len, packet.len()
            );
        }
        Err(e) => println!("[RX][SFRAME] header parse error: {e:?}"),
    }
}

fn inspect_packet_verbose(packet: &[u8]) {
    match SframeHeader::deserialize(packet) {
        Ok(h) => {
            let header_len = h.len();
            let body_len = packet.len().saturating_sub(header_len);
            let header_bytes = &packet[..header_len];
            let body_bytes = &packet[header_len..];
            println!("┌─ [RX] SFrame Packet ─────────────────────────────────────");
            println!("│ Header struct  : {h}");
            println!("│ Header len     : {header_len} bytes");
            println!("│ Header HEX     : {}", hex::encode(header_bytes));
            println!("│ Header BIN     : {}", bytes_to_bin(header_bytes));
            println!("│ KeyId          : {}", h.key_id());
            println!("│ Counter        : {}", h.counter());
            println!("│ Body len       : {body_len} bytes (ciphertext + tag)");
            if body_len >= 16 {
                let ct = &body_bytes[..body_len - 16];
                let tag = &body_bytes[body_len - 16..];
                
                println!("│ Auth Tag HEX   : {}", hex::encode(tag));
            } else {
                println!("│ Body HEX       : {}", hex::encode(body_bytes));
            }
            println!("└──────────────────────────────────────────────────────────");
        }
        Err(e) => println!("[RX][SFRAME] header parse error: {e:?}"),
    }
}

// ───────────────────────── Playback ─────────────────────────

fn build_playback_stream(play_rx: CbReceiver<Vec<u8>>) -> Result<Stream> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("default output device not found"))?;
    println!("[playback] device: {}", device.name()?);
    let default_config = device.default_output_config()?;
    let sample_rate = default_config.sample_rate().0;
    let channels = default_config.channels() as usize;
    let sample_format = default_config.sample_format();
    println!(
        "[playback] config: {} Hz, {} ch, {:?}",
        sample_rate, channels, sample_format
    );

    let config = StreamConfig {
        channels: channels as u16,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let stream = match sample_format {
        // I16 OUT
        SampleFormat::I16 => {
            use std::sync::{Arc, Mutex};
            let out_buf: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
            let out_buf_cb = out_buf.clone();
            let rx = play_rx.clone();

            device.build_output_stream(
                &config,
                move |output: &mut [i16], _| {
                    if let Ok(mut local) = out_buf_cb.lock() {
                        while local.len() < output.len() {
                            match rx.try_recv() {
                                Ok(frame_bytes) => {
                                    let n = frame_bytes.len() / 2;
                                    local.reserve(n);
                                    for i in 0..n {
                                        let lo = frame_bytes[2*i];
                                        let hi = frame_bytes[2*i+1];
                                        local.push(i16::from_le_bytes([lo, hi]));
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        for (i, out) in output.iter_mut().enumerate() {
                            *out = if !local.is_empty() { local.remove(0) } else { 0 };
                        }
                    }
                },
                move |err| eprintln!("playback stream error: {err}"),
                Some(Duration::from_millis(100)),
            )?
        }

        // F32 OUT (convertiamo i16 -> f32)
        SampleFormat::F32 => {
            use std::sync::{Arc, Mutex};
            let out_buf: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
            let out_buf_cb = out_buf.clone();
            let rx = play_rx.clone();

            device.build_output_stream(
                &config,
                move |output: &mut [f32], _| {
                    if let Ok(mut local) = out_buf_cb.lock() {
                        while local.len() < output.len() {
                            match rx.try_recv() {
                                Ok(frame_bytes) => {
                                    let n = frame_bytes.len() / 2;
                                    local.reserve(n);
                                    for i in 0..n {
                                        let lo = frame_bytes[2*i];
                                        let hi = frame_bytes[2*i+1];
                                        let s_i16 = i16::from_le_bytes([lo, hi]);
                                        local.push(s_i16 as f32 / 32768.0);
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        for (i, out) in output.iter_mut().enumerate() {
                            *out = if !local.is_empty() { local.remove(0) } else { 0.0 };
                        }
                    }
                },
                move |err| eprintln!("playback stream error: {err}"),
                Some(Duration::from_millis(100)),
            )?
        }

        _ => {
            return Err(anyhow::anyhow!(
                "Formato output non gestito nel POC: {:?}",
                sample_format
            ));
        }
    };

    stream.play()?;
    Ok(stream)
}

fn rx_loop(
    udp_bind: &str,
    play_tx: CbSender<Vec<u8>>,
    mut receiver: Receiver,
    inspect: bool,
    verbose: bool,
) -> Result<()> {
    let sock = UdpSocket::bind(udp_bind)?;
    println!("[rx] listening on {udp_bind}");
    let mut buf = vec![0u8; 65535];
    let mut i: usize = 0;

    loop {
        let (n, _peer) = sock.recv_from(&mut buf)?;
        let pkt = &buf[..n];

        if inspect {
            if verbose {
                inspect_packet_verbose(pkt);
            } else {
                if i % 50 == 0 { inspect_packet_compact(pkt); }
            }
        }

        match receiver.decrypt_frame(pkt) {
            Ok(plain) => {
                let frame = plain.to_vec(); // i16 LE bytes da TX
                let _ = play_tx.try_send(frame);
            }
            Err(e) => eprintln!("[rx] decrypt error: {e:?}"),
        }
        i = i.wrapping_add(1);
    }
}

fn main() -> Result<()> {
    // Uso: rx_audio <IP:PORT> [inspect|inspect-verbose]
    let bind = std::env::args().nth(1).unwrap_or("0.0.0.0:5000".to_string());
    let inspect_flag = std::env::args().any(|a| a == "inspect" || a == "inspect-verbose");
    let verbose = std::env::args().any(|a| a == "inspect-verbose");

    println!("RX bind: {}", bind);

    let mut r = Receiver::default();
    r.set_encryption_key(1u64, b"SUPER_SECRET")?;

    let (play_tx, play_rx) = bounded::<Vec<u8>>(32);
    let _play_stream = build_playback_stream(play_rx)?;

    rx_loop(&bind, play_tx, r, inspect_flag, verbose)?;
    Ok(())
}
