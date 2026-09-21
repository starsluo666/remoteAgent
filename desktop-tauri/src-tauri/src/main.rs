// RemoteAgent 桌面壳：复用 web/dist 前端，打开即拉起本机 daemon ——
// exe 既是控制端（面板里「连接其他设备」）也是被控端（daemon 注册到中继）。
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            ensure_daemon();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// exe 同目录的 daemon（externalBin 打包）未在服务（9800 未监听）则拉起。
/// 已有独立 daemon 在跑则直接复用——单实例由端口占用自然保证。
/// 本进程退出不杀 daemon：关窗后设备仍在线可被控，重开 exe 无缝接管。
fn ensure_daemon() {
    if std::net::TcpStream::connect("127.0.0.1:9800").is_ok() {
        return;
    }
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    else {
        return;
    };
    let candidate = dir.join("remoteagent-daemon.exe");
    if !candidate.exists() {
        return;
    }

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        // 日志落到临时目录便于排障（tracing 写 stdout，需一并重定向）；
        // CREATE_NO_WINDOW 避免控制台闪窗
        let open_log = || {
            std::fs::File::options()
                .create(true)
                .append(true)
                .open(std::env::temp_dir().join("remoteagent-daemon.log"))
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null())
        };
        let mut c = std::process::Command::new(&candidate);
        c.creation_flags(0x0800_0000)
            .stdout(open_log())
            .stderr(open_log());
        c
    };
    #[cfg(not(windows))]
    let mut cmd = std::process::Command::new(&candidate);

    match cmd.spawn() {
        // leak child handle：与桌面壳进程生命周期解绑
        Ok(child) => std::mem::forget(child),
        Err(e) => {
            #[cfg(windows)]
            {
                // windows_subsystem 下无控制台，写日志文件兜底
                let _ = std::fs::write(
                    std::env::temp_dir().join("remoteagent-desktop-spawn.err"),
                    format!("{e}"),
                );
            }
            #[cfg(not(windows))]
            eprintln!("spawn daemon failed: {e}");
        }
    }
    // 给 daemon 一点启动时间，前端 Landing 探测 /api/local 时已在服务
    std::thread::sleep(std::time::Duration::from_millis(300));
}
