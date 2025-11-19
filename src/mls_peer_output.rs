// src/mls_peer_output.rs

use std::sync::{Arc, Mutex};

use sframe::header::SframeHeader;

use winit::{
    dpi::LogicalSize,
    event::{ElementState, Event, KeyboardInput, VirtualKeyCode, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use pixels::{Pixels, SurfaceTexture};

/// Stampa compatta delle informazioni dell'header SFrame per debug/inspect.
pub fn inspect_packet_compact(prefix: &str, packet: &[u8]) {
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

/// Event loop grafico per mostrare il video RX in una finestra.
///
/// Non ritorna mai (tipo `!`), come `EventLoop::run`.
pub fn run_video_display(fb_video: Arc<Mutex<(usize, usize, Vec<u8>)>>) -> ! {
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("MLS SFrame A/V — ESC per uscire")
        .with_inner_size(LogicalSize::new(640.0, 480.0))
        .build(&event_loop)
        .unwrap();

    let window_size = window.inner_size();
    let surface_texture = SurfaceTexture::new(window_size.width, window_size.height, &window);
    let mut pixels = Pixels::new(640, 480, surface_texture)
        .expect("Pixels::new failed");

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested
                | WindowEvent::KeyboardInput {
                    input: KeyboardInput {
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
                let (w,h,buf) = {
                    let fb = fb_video.lock().unwrap();
                    (fb.0, fb.1, fb.2.clone())
                };
                if w>0 && h>0 && buf.len()==w*h*4 {
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
