// Zvuk računara za stream, ALI bez zvuka same aplikacije.
//
// Kad neko streama sa zvukom, glasovi iz voice kanala koje on čuje (puštaju se iz Lpcalasa)
// bi završili u streamu, pa bi gledaoci čuli sami sebe. Windows (10 2004+) ima "process
// loopback": snimi sve što ide na zvučnike OSIM zadanog procesa i njegovih potprocesa.
// WebView2 (koji pušta glasove) je potproces ove aplikacije, pa se cijeli Lpcalas izbaci.
//
// Zvuk ide u JavaScript kao sirovi f32 stereo 48 kHz blokovi od 20 ms preko Tauri kanala.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Default)]
pub struct SysAudioState {
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[tauri::command]
pub fn start_system_audio(
    state: tauri::State<'_, SysAudioState>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    // Zaustavi prethodno snimanje ako još radi.
    if let Some(old) = state.stop.lock().map_err(|e| e.to_string())?.take() {
        old.store(true, Ordering::SeqCst);
    }
    let stop = Arc::new(AtomicBool::new(false));
    imp::start(stop.clone(), on_data)?;
    *state.stop.lock().map_err(|e| e.to_string())? = Some(stop);
    Ok(())
}

#[tauri::command]
pub fn stop_system_audio(state: tauri::State<'_, SysAudioState>) {
    if let Ok(mut guard) = state.stop.lock() {
        if let Some(stop) = guard.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::mpsc;
    use std::time::Duration;
    use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    const RATE: usize = 48_000;
    const CHANNELS: usize = 2;
    const CHUNK_FRAMES: usize = RATE / 50; // 20 ms

    pub fn start(stop: Arc<AtomicBool>, on_data: Channel<InvokeResponseBody>) -> Result<(), String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("lpcalas-system-audio".into())
            .spawn(move || {
                if let Err(e) = run(stop, on_data, &ready_tx) {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(r) => r,
            Err(_) => Err("Snimanje zvuka se nije pokrenulo na vrijeme.".into()),
        }
    }

    fn run(
        stop: Arc<AtomicBool>,
        on_data: Channel<InvokeResponseBody>,
        ready: &mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let _ = initialize_mta().ok();
        let format = WaveFormat::new(32, 32, SampleType::Float, RATE, CHANNELS, None);
        let block_align = format.get_blockalign() as usize;
        // false = EXCLUDE: sve osim ovog procesa i njegovih potprocesa (WebView2).
        let mut client = AudioClient::new_application_loopback_client(std::process::id(), false)
            .map_err(|e| format!("Windows ne podržava snimanje bez aplikacije: {e}"))?;
        client
            .initialize_client(
                &format,
                Direction::Capture,
                StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 },
                None,
            )
            .map_err(|e| e.to_string())?;
        let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        let _ = ready.send(Ok(()));

        let chunk_bytes = CHUNK_FRAMES * block_align;
        let mut queue: VecDeque<u8> = VecDeque::with_capacity(chunk_bytes * 8);
        while !stop.load(Ordering::SeqCst) {
            // Kad ništa ne svira, Windows ne javlja događaj: samo provjeri stop i nastavi.
            if event.wait_for_event(200).is_err() {
                continue;
            }
            loop {
                match capture.get_next_packet_size() {
                    Ok(Some(n)) if n > 0 => {
                        if capture.read_from_device_to_deque(&mut queue).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            while queue.len() >= chunk_bytes {
                let chunk: Vec<u8> = queue.drain(..chunk_bytes).collect();
                if on_data.send(InvokeResponseBody::Raw(chunk)).is_err() {
                    stop.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
        let _ = client.stop_stream();
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn start(_stop: Arc<AtomicBool>, _on_data: Channel<InvokeResponseBody>) -> Result<(), String> {
        Err("Snimanje zvuka sistema radi samo na Windowsu.".into())
    }
}
