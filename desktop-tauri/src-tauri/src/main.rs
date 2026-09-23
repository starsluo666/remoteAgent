// 桌面入口（Windows）。移动端经 lib.rs 的 mobile_entry_point 进入。
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    remoteagent_desktop_lib::run()
}
