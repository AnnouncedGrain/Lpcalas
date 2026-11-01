// Sakriva WebView2 traku "... dijeli vaš ekran  [Prestani dijeliti] [Sakrij]" koja se pojavi na dnu
// ekrana kad počne stream. WebView2 nema postavku za to, pa nakon početka streama tražimo taj
// prozor (mali prozor s naslovom, iz WebView2 procesa naše aplikacije) i sakrijemo ga.
// Stream se i dalje zaustavlja iz aplikacije.

#[cfg(windows)]
mod imp {
    use std::collections::HashSet;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow,
        SW_HIDE,
    };

    // Svi procesi koji su "djeca" (i unuci) naše aplikacije, tj. WebView2 procesi.
    fn descendants(root: u32) -> HashSet<u32> {
        let mut parents: Vec<(u32, u32)> = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return HashSet::new();
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut e) != 0 {
                loop {
                    parents.push((e.th32ProcessID, e.th32ParentProcessID));
                    if Process32NextW(snap, &mut e) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        let mut set = HashSet::new();
        let mut frontier = vec![root];
        while let Some(p) = frontier.pop() {
            for &(child, parent) in &parents {
                if parent == p && child != root && set.insert(child) {
                    frontier.push(child);
                }
            }
        }
        set
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam as *mut Vec<HWND>);
        list.push(hwnd);
        1
    }

    fn hide_once(procs: &HashSet<u32>) -> usize {
        let mut windows: Vec<HWND> = Vec::new();
        let mut hidden = 0;
        unsafe {
            EnumWindows(Some(collect), &mut windows as *mut Vec<HWND> as LPARAM);
            for hwnd in windows {
                if IsWindowVisible(hwnd) == 0 {
                    continue;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if !procs.contains(&pid) {
                    continue;
                }
                // Padajući meniji i tooltipovi nemaju naslov; traka ima ("... is sharing your screen").
                if GetWindowTextLengthW(hwnd) == 0 {
                    continue;
                }
                let mut r: RECT = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut r) == 0 {
                    continue;
                }
                let h = r.bottom - r.top;
                let w = r.right - r.left;
                if h > 0 && h <= 240 && w >= 200 {
                    ShowWindow(hwnd, SW_HIDE);
                    hidden += 1;
                }
            }
        }
        hidden
    }

    pub fn start() {
        std::thread::spawn(|| {
            let me = std::process::id();
            let started = Instant::now();
            let mut found_at: Option<Instant> = None;
            let mut procs = descendants(me);
            let mut last_scan = Instant::now();
            // Traka se pojavi odmah nakon početka streama; tražimo je do 15 s, a kad je nađemo još 2 s.
            while started.elapsed() < Duration::from_secs(15) {
                if last_scan.elapsed() > Duration::from_secs(2) {
                    procs = descendants(me);
                    last_scan = Instant::now();
                }
                if hide_once(&procs) > 0 && found_at.is_none() {
                    found_at = Some(Instant::now());
                }
                if let Some(t) = found_at {
                    if t.elapsed() > Duration::from_secs(2) {
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }
}

#[tauri::command]
pub fn hide_share_bar() {
    #[cfg(windows)]
    imp::start();
}
