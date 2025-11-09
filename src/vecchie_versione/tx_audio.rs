// src/tx_audio.rs
use anyhow::Result;
use crossbeam_channel::{bounded, Receiver as CbReceiver};
use std::{net::UdpSocket, time::Duration};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};

mod sender;
use sender::Sender;

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
                "[TX][SFRAME] kid={} ctr={} | aad={}B ct={}B tag={}B total={}B",
                h.key_id(), h.counter(), header_len, ct_len, tag_len, packet.len()
            );
        }
        Err(e) => println!("[TX][SFRAME] header parse error: {e:?}"),
    }
}

fn inspect_packet_verbose(packet: &[u8]) {
    match SframeHeader::deserialize(packet) {
        Ok(h) => {
            let header_len = h.len();
            let body_len = packet.len().saturating_sub(header_len);
            let header_bytes = &packet[..header_len];
            let body_bytes = &packet[header_len..];
            println!("┌─ [TX] SFrame Packet ─────────────────────────────────────");
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
                println!("│ Ciphertext HEX : {}", hex::encode(ct));
                println!("│ Auth Tag HEX   : {}", hex::encode(tag));
            } else {
                println!("│ Body HEX       : {}", hex::encode(body_bytes));
            }
            println!("└──────────────────────────────────────────────────────────");
        }
        Err(e) => println!("[TX][SFRAME] header parse error: {e:?}"),
    }
}

// ───────────────────────── Capture & send ─────────────────────────

/// Crea e avvia lo stream di cattura CPAL.
/// Ritorna:
/// - canale con frame PCM i16 (LE) di durata `frame_ms`
/// - lo Stream CPAL (da TENERE VIVO nello scope chiamante)
/// - i bytes per frame (informativo)
fn build_capture_stream(
    device_name: Option<String>,
    frame_ms: u32,
) -> Result<(CbReceiver<Vec<u8>>, Stream, usize)> {
    let host = cpal::default_host();
    let device = if let Some(name) = device_name {
        host.input_devices()?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| anyhow::anyhow!("input device '{}' non trovato", name))?
    } else {
        host.default_input_device().ok_or_else(|| anyhow::anyhow!("default input device non trovato"))?
    };

    println!("[capture] device: {}", device.name()?);

    let default_config = device.default_input_config()?;
    let sample_rate = default_config.sample_rate().0;
    let channels = default_config.channels() as usize;
    let sample_format = default_config.sample_format();
    println!(
        "[capture] default config: {} Hz, {} ch, {:?}",
        sample_rate, channels, sample_format
    );

    // 20 ms tipico per realtime
    let frame_samples = (sample_rate as u32 * frame_ms / 1000) as usize;
    let frame_bytes = frame_samples * channels * 2; // i16 -> 2 byte

    let config = StreamConfig {
        channels: channels as u16,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let (tx, rx) = bounded::<Vec<u8>>(32);

    let stream = match sample_format {
        // I16 in
        SampleFormat::I16 => {
            use std::sync::{Arc, Mutex};
            let acc: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
            let acc_cb = acc.clone();

            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    if let Ok(mut buf) = acc_cb.lock() {
                        buf.extend_from_slice(data);
                        let need = frame_samples * channels;
                        while buf.len() >= need {
                            let mut frame = vec![0u8; need * 2];
                            for i in 0..need {
                                let b = buf[i].to_le_bytes();
                                frame[2 * i] = b[0];
                                frame[2 * i + 1] = b[1];
                            }
                            let _ = tx.try_send(frame);
                            buf.drain(0..need);
                        }
                    }
                },
                move |err| eprintln!("input stream error: {err}"),
                Some(Duration::from_millis(100)),
            )?
        }

        // F32 in (converti a i16)
        SampleFormat::F32 => {
            use std::sync::{Arc, Mutex};
            let acc: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
            let acc_cb = acc.clone();

            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    if let Ok(mut buf) = acc_cb.lock() {
                        buf.extend_from_slice(data);
                        let need = frame_samples * channels;
                        while buf.len() >= need {
                            let mut frame = vec![0u8; need * 2];
                            for i in 0..need {
                                let s = (buf[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
                                let b = s.to_le_bytes();
                                frame[2 * i] = b[0];
                                frame[2 * i + 1] = b[1];
                            }
                            let _ = tx.try_send(frame);
                            buf.drain(0..need);
                        }
                    }
                },
                move |err| eprintln!("input stream error: {err}"),
                Some(Duration::from_millis(100)),
            )?
        }

        // U16 in (converti a i16, centrando)
        SampleFormat::U16 => {
            use std::sync::{Arc, Mutex};
            let acc: Arc<Mutex<Vec<u16>>> = Arc::new(Mutex::new(Vec::new()));
            let acc_cb = acc.clone();

            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    if let Ok(mut buf) = acc_cb.lock() {
                        buf.extend_from_slice(data);
                        let need = frame_samples * channels;
                        while buf.len() >= need {
                            let mut frame = vec![0u8; need * 2];
                            for i in 0..need {
                                let s_i16 = (buf[i] as i32 - 32768) as i16;
                                let b = s_i16.to_le_bytes();
                                frame[2 * i] = b[0];
                                frame[2 * i + 1] = b[1];
                            }
                            let _ = tx.try_send(frame);
                            buf.drain(0..need);
                        }
                    }
                },
                move |err| eprintln!("input stream error: {err}"),
                Some(Duration::from_millis(100)),
            )?
        }

        // SampleFormat è non-exhaustive: fallback
        _ => {
            return Err(anyhow::anyhow!(
                "Formato input non gestito nel POC: {:?}",
                sample_format
            ));
        }
    };

    stream.play()?;
    Ok((rx, stream, frame_bytes))
}

/// Calcola RMS (in scala i16) di un frame che è bytes LE i16 interleaved.
/// Ritorna valore RMS come f64 (0..~32768)
fn frame_rms_i16_le(frame_bytes: &[u8]) -> f64 {
    let n_samples = frame_bytes.len() / 2;
    if n_samples == 0 { return 0.0; }
    let mut sum_sq: f64 = 0.0;
    for i in 0..n_samples {
        let lo = frame_bytes[2*i] as i16 as i16;
        let hi = frame_bytes[2*i+1] as i16 as i16;
        let s = i16::from_le_bytes([lo as u8, hi as u8]) as f64;
        sum_sq += s * s;
    }
    (sum_sq / (n_samples as f64)).sqrt()
}

fn tx_loop(
    rx: CbReceiver<Vec<u8>>,
    udp_dst: &str,
    mut sender: Sender,
    inspect: bool,
    verbose: bool,
    skip_silence: bool,
    silence_threshold: f64,
) -> Result<()> {
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.connect(udp_dst)?;
    println!("[tx] sending to {udp_dst} (skip_silence={} thr={})", skip_silence, silence_threshold);

    let mut i: usize = 0;
    let mut sent_cnt: usize = 0;
    let mut skipped_cnt: usize = 0;

    for frame in rx.iter() {
        // se abilitato, calcola RMS e decide se inviare
        let mut do_send = true;
        if skip_silence {
            let rms = frame_rms_i16_le(&frame);
            // per debug stampa qualche valore
            if i % 200 == 0 {
                println!("[tx] frame #{i} rms={:.2}", rms);
            }
            if rms <= silence_threshold {
                do_send = false;
            }
        }

        if !do_send {
            skipped_cnt = skipped_cnt.wrapping_add(1);
            if skipped_cnt % 50 == 0 {
                println!("[tx] skipped frames: {skipped_cnt} (last checked frame #{i})");
            }
            i = i.wrapping_add(1);
            continue;
        }

        match sender.encrypt_frame(&frame) {
            Ok(pkt) => {
                if inspect {
                    if verbose {
                        inspect_packet_verbose(pkt);
                    } else {
                        if sent_cnt % 50 == 0 { inspect_packet_compact(pkt); }
                    }
                }
                let _ = sock.send(pkt);
                sent_cnt = sent_cnt.wrapping_add(1);
            }
            Err(e) => eprintln!("[tx] encrypt error: {e:?}"),
        }
        i = i.wrapping_add(1);
    }
    Ok(())
}

fn main() -> Result<()> {
    // Uso:
    // tx_audio <IP:PORT> [NomeDispositivo] [inspect|inspect-verbose] [nosend|<threshold>]
    // - passare "nosend" abilita skip_silence con soglia default 500
    // - oppure passare numero (es. 1000) per cambiare soglia
    let mut args = std::env::args().skip(1);
    let dst = args.next().unwrap_or_else(|| "127.0.0.1:5000".to_string());
    let maybe_device = args.next();
    let mut inspect_flag = false;
    let mut verbose = false;
    let mut skip_silence = false;
    let mut silence_threshold: f64 = 500.0; // default

    // parse remaining args
    for a in args {
        match a.as_str() {
            "inspect" => inspect_flag = true,
            "inspect-verbose" => { inspect_flag = true; verbose = true; }
            "nosend" => skip_silence = true,
            other => {
                // try parse as threshold number
                if let Ok(v) = other.parse::<f64>() {
                    skip_silence = true;
                    silence_threshold = v;
                } else {
                    // treat as device name if not already set (unlikely here)
                }
            }
        }
    }

    let device_name = maybe_device.filter(|s| s != "inspect" && s != "inspect-verbose" && s != "nosend");

    let frame_ms = 20u32;

    // Sender SFrame
    let mut s = Sender::new(1u64);
    s.set_encryption_key(b"SUPER_SECRET")?;

    // Costruisci lo stream e TEGNILO VIVO con una variabile
    let (audio_rx, _capture_stream, _frame_bytes) = build_capture_stream(device_name, frame_ms)?;

    // Avvia il loop di invio (lo stream resta vivo finché questa funzione non termina)
    tx_loop(audio_rx, &dst, s, inspect_flag, verbose, skip_silence, silence_threshold)?;
    Ok(())
}
