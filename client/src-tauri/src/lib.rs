mod hotkeys;
mod sharebar;
mod sysaudio;

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn set_hotkeys(state: tauri::State<'_, hotkeys::HotkeyState>, bindings: Vec<hotkeys::Binding>) {
    if let Ok(mut current) = state.bindings.lock() {
        *current = bindings;
    }
}

// Kontrola pop-out prozora streama (pronalazi ga po naslovu koji postavi aplikacija).
#[tauri::command]
fn popout_control(app: tauri::AppHandle, title: String, action: String) -> bool {
    let popouts: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("popout-"))
        .map(|(_, w)| w)
        .collect();
    let target = popouts
        .iter()
        .find(|w| w.title().map(|t| t == title).unwrap_or(false))
        .or(if popouts.len() == 1 { popouts.first() } else { None });
    let Some(w) = target else { return false };
    match action.as_str() {
        "pin" => w.set_always_on_top(true).is_ok(),
        "unpin" => w.set_always_on_top(false).is_ok(),
        "maximize" => {
            if w.is_maximized().unwrap_or(false) {
                w.unmaximize().is_ok()
            } else {
                w.maximize().is_ok()
            }
        }
        _ => false,
    }
}

pub fn run() {
    let hotkey_state = hotkeys::HotkeyState::default();
    let thread_state = hotkey_state.clone();

    tauri::Builder::default()
        // Druga instanca samo prebaci fokus na već otvoren prozor.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::FULLSCREEN)
                .build(),
        )
        .manage(hotkey_state)
        .manage(sysaudio::SysAudioState::default())
        .setup(move |app| {
            hotkeys::start(app.handle().clone(), thread_state.clone());

            // Glavni prozor pravimo ovdje (ne iz konfiguracije) da bismo mogli otvarati pop-out prozore:
            // window.open('') napravi pravi Windows prozor koji dijeli memoriju s aplikacijom.
            let handle = app.handle().clone();
            let counter = AtomicU32::new(0);
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("nema konfiguracije glavnog prozora");
            WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_new_window(move |url, features| {
                    if url.scheme() != "about" {
                        // Obični linkovi idu u browser.
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                        return NewWindowResponse::Deny;
                    }
                    let label = format!("popout-{}", counter.fetch_add(1, Ordering::SeqCst));
                    let built = WebviewWindowBuilder::new(&handle, &label, WebviewUrl::External("about:blank".parse().unwrap()))
                        .window_features(features)
                        .title("Lpcalas")
                        .min_inner_size(320.0, 180.0)
                        .on_document_title_changed(|w, title| {
                            let _ = w.set_title(&title);
                        })
                        .build();
                    match built {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(_) => NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        // Kad se zatvori glavni prozor, zatvori i pop-out prozore (inače bi aplikacija ostala upaljena).
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_hotkeys,
            popout_control,
            sharebar::hide_share_bar,
            hotkeys::capture_key,
            sysaudio::start_system_audio,
            sysaudio::stop_system_audio
        ])
        .run(tauri::generate_context!())
        .expect("greška pri pokretanju aplikacije");
}
