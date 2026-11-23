//! The default microphone for the window, captured natively: WebKit's takes about two seconds to start, as it goes
//! through macOS's voice processing. Streams 16 kHz mono 16-bit samples over a channel, then an empty message once
//! closed.

use crate::App;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

const RATE: u32 = 16_000;
/// Samples per message, a tenth of a second.
const CHUNK: usize = 1600;

#[derive(Default)]
pub(crate) struct Mics {
    open: Mutex<HashMap<u64, mpsc::Sender<()>>>,
    next: AtomicU64,
}

impl Mics {
    /// Closes every microphone, when the window reloads.
    pub(crate) fn close_all(&self) {
        self.open.lock().unwrap().drain().for_each(|(_, stop)| _ = stop.send(()));
    }
}

/// Averages the input over each output sample, which also filters out what 16 kHz cannot hold.
struct Resampler {
    rate: u32,
    phase: u32,
    sum: f32,
    count: u32,
    out: Vec<u8>,
}

impl Resampler {
    fn push(&mut self, sample: f32) {
        self.sum += sample;
        self.count += 1;
        self.phase += RATE;
        if self.phase >= self.rate {
            self.phase -= self.rate;
            let value = (self.sum / self.count as f32 * 32767.0).clamp(-32768.0, 32767.0) as i16;
            self.out.extend_from_slice(&value.to_le_bytes());
            self.sum = 0.0;
            self.count = 0;
        }
    }
}

fn capture(resampler: Arc<Mutex<Resampler>>, sink: Channel<InvokeResponseBody>) -> Result<cpal::Stream, String> {
    let device = cpal::default_host().default_input_device().ok_or("No microphone")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?.config();
    let channels = config.channels as usize;
    resampler.lock().unwrap().rate = config.sample_rate;
    let stream = device
        .build_input_stream::<f32, _, _>(
            config,
            move |data, _| {
                let mut resampler = resampler.lock().unwrap();
                for frame in data.chunks(channels) {
                    resampler.push(frame.iter().sum::<f32>() / channels as f32);
                }
                if resampler.out.len() >= CHUNK * 2 {
                    _ = sink.send(InvokeResponseBody::Raw(std::mem::take(&mut resampler.out)));
                }
            },
            |e| eprintln!("microphone: {e}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

#[tauri::command(async)]
pub(crate) fn mic_open(app: State<App>, output: Channel<InvokeResponseBody>) -> Result<u64, String> {
    let (stop, stopped) = mpsc::channel();
    let (started, start) = mpsc::channel();
    thread::spawn(move || {
        let resampler = Arc::new(Mutex::new(Resampler { rate: 0, phase: 0, sum: 0.0, count: 0, out: Vec::new() }));
        let stream = match capture(resampler.clone(), output.clone()) {
            Ok(stream) => stream,
            Err(e) => return drop(started.send(Err(e))),
        };
        _ = started.send(Ok(()));
        _ = stopped.recv();
        drop(stream);
        let rest = std::mem::take(&mut resampler.lock().unwrap().out);
        if !rest.is_empty() {
            _ = output.send(InvokeResponseBody::Raw(rest));
        }
        _ = output.send(InvokeResponseBody::Raw(Vec::new()));
    });
    start.recv().map_err(|e| e.to_string())??;
    let id = app.mics.next.fetch_add(1, Ordering::Relaxed);
    app.mics.open.lock().unwrap().insert(id, stop);
    Ok(id)
}

/// Stops the microphone, which then sends what it has left and the closing empty message.
#[tauri::command]
pub(crate) fn mic_close(app: State<App>, id: u64) {
    if let Some(stop) = app.mics.open.lock().unwrap().remove(&id) {
        _ = stop.send(());
    }
}
