// Dijagnostika memorije: koliko RAM-a troši Lpcalas i svaki njegov WebView2 potproces.
// Služi da se vidi gdje raste memorija (JavaScript, video dekodiranje u GPU procesu...).

use serde::Serialize;

#[derive(Serialize)]
pub struct ProcMem {
    pid: u32,
    name: String,
    // Privatna memorija (ono što Task Manager pokazuje u koloni "Memory"), u MB.
    private_mb: f64,
    working_set_mb: f64,
}

#[cfg(windows)]
mod imp {
    use super::ProcMem;
    use std::collections::HashSet;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub fn usage() -> Vec<ProcMem> {
        let me = std::process::id();
        let mut all: Vec<(u32, u32, String)> = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Vec::new();
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut e) != 0 {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    all.push((e.th32ProcessID, e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len])));
                    if Process32NextW(snap, &mut e) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        let mut tree: HashSet<u32> = HashSet::from([me]);
        let mut changed = true;
        while changed {
            changed = false;
            for (pid, parent, _) in &all {
                if tree.contains(parent) && !tree.contains(pid) {
                    tree.insert(*pid);
                    changed = true;
                }
            }
        }
        let mut out = Vec::new();
        for (pid, _, name) in all.into_iter().filter(|(pid, _, _)| tree.contains(pid)) {
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    continue;
                }
                let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
                c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                let ok = GetProcessMemoryInfo(h, &mut c as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS, c.cb);
                CloseHandle(h);
                if ok != 0 {
                    out.push(ProcMem {
                        pid,
                        name,
                        private_mb: (c.PrivateUsage as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                        working_set_mb: (c.WorkingSetSize as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                    });
                }
            }
        }
        out.sort_by(|a, b| b.private_mb.partial_cmp(&a.private_mb).unwrap_or(std::cmp::Ordering::Equal));
        out
    }
}

#[tauri::command]
pub fn memory_usage() -> Vec<ProcMem> {
    #[cfg(windows)]
    {
        imp::usage()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}
