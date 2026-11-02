#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[derive(Clone)]
struct ApiProcess(Arc<Mutex<Option<Child>>>);

#[allow(dead_code)]
fn append_log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn stop_api(state: &ApiProcess) {
    if let Ok(mut child) = state.0.lock() {
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

#[cfg(all(windows, not(debug_assertions)))]
mod windows_dialog {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;
    const MB_RIGHT: u32 = 0x0008_0000;
    const MB_RTLREADING: u32 = 0x0010_0000;

    pub fn error(text: &str) {
        let message: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let caption: Vec<u16> = "روشن فروشگاهی"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            MessageBoxW(
                0,
                message.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST | MB_RIGHT | MB_RTLREADING,
            );
        }
    }
}

#[cfg(not(debug_assertions))]
fn read_tail(path: &Path, max_chars: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let length = content.chars().count();
    if length <= max_chars {
        return content;
    }
    content.chars().skip(length - max_chars).collect()
}

/// The bundled API streams its stdout/stderr into api.log. Without a cap the
/// file would grow forever on machines that run for years; keep only the tail.
#[cfg(not(debug_assertions))]
fn cap_log(path: &Path) {
    const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
    const KEPT_TAIL_CHARS: usize = 64 * 1024;
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            let tail = read_tail(path, KEPT_TAIL_CHARS);
            if std::fs::write(path, tail).is_err() {
                // Never block startup over log rotation.
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Tauri resolves `current_exe()` through `Path::canonicalize()`, which on
/// Windows returns verbatim paths (`\\?\C:\...`). Node.js 22+ crashes with
/// `EISDIR: illegal operation on a directory, lstat 'C:'` when its main
/// script path carries that prefix, so convert the resolved runtime path
/// back to a normal Win32 path before spawning the bundled API.
#[cfg(not(debug_assertions))]
fn strip_verbatim_prefix(path: &Path) -> std::path::PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Reports a bundled API startup failure to the user (dialog + log)
/// instead of letting the process exit silently.
#[cfg(not(debug_assertions))]
fn report_startup_failure(api_log: &Path, message: &str) {
    append_log(api_log, message);
    let full = format!(
        "اجرای بخش محلی برنامه با خطا مواجه شد.\n\n{}\n\nبرای جزئیات بیشتر، این فایل را بررسی کنید:\n{}",
        message,
        api_log.display()
    );
    #[cfg(windows)]
    windows_dialog::error(&full);
    #[cfg(not(windows))]
    eprintln!("{full}");
}

/// Starts the bundled Node.js API in the background.
/// The main window is shown immediately; the frontend polls /api/auth/health
/// until this API is ready, so a slow first start (antivirus scans, cold disk)
/// must never block or close the window.
#[cfg(not(debug_assertions))]
fn start_bundled_api(app: tauri::AppHandle, closing: Arc<AtomicBool>) {
    let base_dir = match std::env::var_os("APPDATA") {
        Some(value) => std::path::PathBuf::from(value),
        None => match app.path().app_data_dir() {
            Ok(dir) => dir,
            Err(error) => {
                eprintln!("Could not resolve the local data directory: {error}");
                return;
            }
        },
    };
    let data_dir = base_dir.join("DarPOSERP");
    let api_log = data_dir.join("api.log");
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        report_startup_failure(&api_log, &format!("Could not create the local data directory: {error}"));
        return;
    }
    cap_log(&api_log);
    // LAN modes (written by the Settings page via set_network_mode):
    // an http(s) URL means this machine is a network client — the bundled
    // API must not start; "server" binds 0.0.0.0 so other machines connect.
    let network_mode = std::fs::read_to_string(data_dir.join("network-mode"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if network_mode.starts_with("http") {
        append_log(&api_log, &format!("Network client mode: using remote server {network_mode}; the bundled API is not started."));
        return;
    }
    let api_host = if network_mode == "server" { "0.0.0.0" } else { "127.0.0.1" };
    append_log(&api_log, "Starting the bundled local POS API.");

    let runtime = match app.path().resolve("runtime", tauri::path::BaseDirectory::Resource) {
        Ok(path) => strip_verbatim_prefix(&path),
        Err(error) => {
            report_startup_failure(&api_log, &format!("Could not resolve the bundled runtime: {error}"));
            return;
        }
    };
    append_log(&api_log, &format!("Bundled runtime at {}", runtime.display()));
    let node = runtime.join("node.exe");
    let server_dir = runtime.join("server");
    let entry = server_dir.join("dist").join("main.js");
    if !node.is_file() || !entry.is_file() {
        report_startup_failure(
            &api_log,
            &format!(
                "Bundled API files are missing. node={}, entry={}",
                node.display(),
                entry.display()
            ),
        );
        return;
    }

    // Another copy of the app (or a leftover API) is already serving the port:
    // reuse it instead of spawning a Node child that would die with EADDRINUSE.
    if TcpStream::connect(("127.0.0.1", 4317)).is_ok() {
        append_log(&api_log, "Port 4317 is already in use; reusing the existing local API.");
        return;
    }

    let stdout = match OpenOptions::new().create(true).append(true).open(&api_log) {
        Ok(file) => file,
        Err(error) => {
            report_startup_failure(&api_log, &format!("Could not open the API log file: {error}"));
            return;
        }
    };
    let stderr = match stdout.try_clone() {
        Ok(file) => file,
        Err(error) => {
            report_startup_failure(&api_log, &format!("Could not duplicate the API log file handle: {error}"));
            return;
        }
    };
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .env("POS_DATA_DIR", &data_dir)
        .env("API_HOST", api_host)
        .env("API_PORT", "4317")
        .current_dir(&server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console window next to the POS window.
        command.creation_flags(0x0800_0000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            report_startup_failure(&api_log, &format!("Could not start the bundled Node.js: {error}"));
            return;
        }
    };

    // Up to 180 seconds: the first launch on a slow machine with an antivirus
    // scanning the bundled runtime can take far longer than a dev cold start.
    let mut ready = false;
    for _ in 0..360 {
        if closing.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        if TcpStream::connect(("127.0.0.1", 4317)).is_ok() {
            ready = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let details = read_tail(&api_log, 4000);
                report_startup_failure(
                    &api_log,
                    &format!("The local POS API exited during startup: {status}.\n--- api.log ---\n{details}"),
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                report_startup_failure(&api_log, &format!("Could not check the bundled API process: {error}"));
                return;
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        report_startup_failure(&api_log, "The local POS API did not start within 180 seconds.");
        return;
    }
    append_log(&api_log, "Bundled API is ready on 127.0.0.1:4317.");
    if closing.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        return;
    }
    match app.state::<ApiProcess>().0.lock() {
        Ok(mut state) => *state = Some(child),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            report_startup_failure(&api_log, "Could not retain the bundled API process handle.");
        }
    }
}

fn main() {
    let child_state = ApiProcess(Arc::new(Mutex::new(None)));
    let state_for_exit = child_state.clone();
    let closing = Arc::new(AtomicBool::new(false));
    let closing_for_setup = closing.clone();
    let closing_for_exit = closing.clone();
    tauri::Builder::default()
        .manage(child_state)
        .invoke_handler(tauri::generate_handler![set_network_mode, open_url])
        .setup(move |app| {
            #[cfg(not(debug_assertions))]
            {
                let app_handle = app.handle().clone();
                thread::spawn(move || start_bundled_api(app_handle, closing_for_setup));
            }
            #[cfg(debug_assertions)]
            {
                let _ = closing_for_setup;
                let _ = app;
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                closing_for_exit.store(true, Ordering::SeqCst);
                stop_api(&state_for_exit);
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Dar POS");
}

/// Shared data directory (same resolution logic as the bundled API spawn:
/// %APPDATA%\DarPOSERP, with Tauri's app data dir as a fallback).
fn app_data_directory(app: &tauri::AppHandle) -> std::path::PathBuf {
    let base = match std::env::var_os("APPDATA") {
        Some(value) => std::path::PathBuf::from(value),
        None => app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(".")),
    };
    base.join("DarPOSERP")
}

/// Persists the LAN mode for the next start:
/// - "" / "local": bundled API on 127.0.0.1 (default, single machine)
/// - "server": bundled API on 0.0.0.0 so other registers can connect
/// - "http://…": client mode — do not start a local API at all
#[tauri::command]
fn set_network_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let dir = app_data_directory(&app);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let normalized = mode.trim();
    if !(normalized.is_empty() || normalized == "local" || normalized == "server" || normalized.starts_with("http")) {
        return Err("unsupported network mode".into());
    }
    std::fs::write(dir.join("network-mode"), normalized).map_err(|error| error.to_string())
}

/// Opens a URL in the system browser (used for release downloads).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("unsupported url".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url.as_str()])
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
