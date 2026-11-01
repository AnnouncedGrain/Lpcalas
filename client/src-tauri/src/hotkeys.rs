// Globalne tipke (push-to-talk, mute, deafen).
//
// Umjesto RegisterHotKey (koji "pojede" tipku pa je igra ne vidi) ovdje se stanje
// tipki čita sa GetAsyncKeyState svakih ~8 ms. Igra i dalje normalno dobija tipku,
// a radi i za dugmad miša (Miš 4 / Miš 5).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Deserialize)]
pub struct Binding {
    pub action: String,
    pub vk: i32,
}

#[derive(Clone, Serialize)]
struct HotkeyEvent {
    action: String,
    pressed: bool,
}

#[derive(Serialize)]
pub struct CapturedKey {
    vk: i32,
    name: String,
}

#[derive(Default, Clone)]
pub struct HotkeyState {
    pub bindings: Arc<Mutex<Vec<Binding>>>,
}

#[cfg(windows)]
fn is_down(vk: i32) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let state = unsafe { GetAsyncKeyState(vk) } as u16;
    (state & 0x8000) != 0
}

#[cfg(not(windows))]
fn is_down(_vk: i32) -> bool {
    false
}

pub fn start(app: AppHandle, state: HotkeyState) {
    std::thread::spawn(move || {
        let mut pressed: HashMap<String, bool> = HashMap::new();
        loop {
            let bindings: Vec<Binding> = match state.bindings.lock() {
                Ok(b) => b.clone(),
                Err(_) => Vec::new(),
            };
            if bindings.is_empty() {
                pressed.clear();
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            for b in &bindings {
                let down = is_down(b.vk);
                let was = pressed.get(&b.action).copied().unwrap_or(false);
                if down != was {
                    pressed.insert(b.action.clone(), down);
                    let _ = app.emit(
                        "hotkey",
                        HotkeyEvent {
                            action: b.action.clone(),
                            pressed: down,
                        },
                    );
                }
            }
            pressed.retain(|action, _| bindings.iter().any(|b| &b.action == action));
            std::thread::sleep(Duration::from_millis(8));
        }
    });
}

// Lijevi/desni klik i generički Shift/Ctrl/Alt preskačemo (koriste se lijeve/desne varijante).
fn capturable(vk: i32) -> bool {
    !matches!(vk, 0x01 | 0x02 | 0x10 | 0x11 | 0x12 | 0xFF)
}

fn any_down() -> bool {
    (1..255).any(|vk| capturable(vk) && is_down(vk))
}

fn capture_blocking() -> Option<CapturedKey> {
    // Prvo sačekaj da se sve otpusti (npr. Enter kojim je kliknuto dugme).
    let wait_start = Instant::now();
    while any_down() && wait_start.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        for vk in 1..255 {
            if capturable(vk) && is_down(vk) {
                if vk == 0x1B {
                    return None; // Escape = odustani
                }
                return Some(CapturedKey {
                    vk,
                    name: key_name(vk),
                });
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

#[tauri::command]
pub async fn capture_key() -> Option<CapturedKey> {
    tauri::async_runtime::spawn_blocking(capture_blocking)
        .await
        .ok()
        .flatten()
}

fn key_name(vk: i32) -> String {
    let fixed = match vk {
        0x04 => Some("Srednji klik"),
        0x05 => Some("Miš 4"),
        0x06 => Some("Miš 5"),
        0x08 => Some("Backspace"),
        0x09 => Some("Tab"),
        0x0D => Some("Enter"),
        0x13 => Some("Pause"),
        0x14 => Some("Caps Lock"),
        0x20 => Some("Space"),
        0x21 => Some("Page Up"),
        0x22 => Some("Page Down"),
        0x23 => Some("End"),
        0x24 => Some("Home"),
        0x25 => Some("Lijevo"),
        0x26 => Some("Gore"),
        0x27 => Some("Desno"),
        0x28 => Some("Dole"),
        0x2D => Some("Insert"),
        0x2E => Some("Delete"),
        0xA0 => Some("Lijevi Shift"),
        0xA1 => Some("Desni Shift"),
        0xA2 => Some("Lijevi Ctrl"),
        0xA3 => Some("Desni Ctrl"),
        0xA4 => Some("Lijevi Alt"),
        0xA5 => Some("Desni Alt"),
        _ => None,
    };
    if let Some(name) = fixed {
        return name.to_string();
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => return ((vk as u8) as char).to_string(),
        0x60..=0x69 => return format!("Num {}", vk - 0x60),
        0x70..=0x87 => return format!("F{}", vk - 0x6F),
        _ => {}
    }
    os_key_name(vk).unwrap_or_else(|| format!("Tipka {}", vk))
}

#[cfg(windows)]
fn os_key_name(vk: i32) -> Option<String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyNameTextW, MapVirtualKeyW, MAPVK_VK_TO_VSC};
    unsafe {
        let scan = MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC);
        if scan == 0 {
            return None;
        }
        let mut buf = [0u16; 64];
        let len = GetKeyNameTextW((scan << 16) as i32, buf.as_mut_ptr(), buf.len() as i32);
        if len > 0 {
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn os_key_name(_vk: i32) -> Option<String> {
    None
}
