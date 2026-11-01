mod hotkeys;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[tauri::command]
fn set_hotkeys(state: tauri::State<'_, hotkeys::HotkeyState>, bindings: Vec<hotkeys::Binding>) {
    if let Ok(mut current) = state.bindings.lock() {
        *current = bindings;
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
        .setup(move |app| {
            hotkeys::start(app.handle().clone(), thread_state.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_hotkeys, hotkeys::capture_key])
        .run(tauri::generate_context!())
        .expect("greška pri pokretanju aplikacije");
}
