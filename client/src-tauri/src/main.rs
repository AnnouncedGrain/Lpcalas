// U release verziji bez dodatnog konzolnog prozora na Windowsu.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lpcalas_lib::run()
}
