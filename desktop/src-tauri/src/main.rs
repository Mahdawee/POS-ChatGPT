#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{Read, Write};
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
/// Best-effort primary LAN IPv4 of this machine: a UDP "connect" only picks
/// the route (no packet leaves the machine), then local_addr names it.
/// Returns None without a default route — callers must treat that as "unknown".
#[cfg(not(debug_assertions))]
fn primary_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?;
    let ip = address.ip().to_string();
    if ip.starts_with("127.") { None } else { Some(ip) }
}

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

/// Asks the API already listening on 127.0.0.1:4317 which mode it bound to.
/// Offline shops have no internet route, so the LAN-IP probe above returns
/// nothing there — this check keeps server mode from silently failing.
#[cfg(not(debug_assertions))]
fn local_api_reports_server_mode() -> Option<bool> {
    let mut stream = TcpStream::connect(("127.0.0.1", 4317)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = b"GET /api/auth/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    stream.write_all(request).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response);
    Some(text.contains("\"mode\":\"server\""))
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
        // Server-mode trap: a leftover single-computer instance is bound to
        // 127.0.0.1 only, so other registers would never reach it even though
        // this app "reused" a listening API. Probe the LAN address too and
        // tell the user plainly instead of failing silently.
        if network_mode == "server" {
            // Reachable on the LAN address → the running API is already in
            // server mode. Offline machines get no LAN IP from the 8.8.8.8
            // trick, so fall back to asking the API itself what it bound to.
            let lan_ok = primary_lan_ip()
                .map(|lan_ip| TcpStream::connect((lan_ip.as_str(), 4317)).is_ok())
                .unwrap_or(false);
            if !lan_ok && !local_api_reports_server_mode().unwrap_or(false) {
                let message = "An older single-computer instance of the API is still listening on 127.0.0.1 only, so network-server mode cannot take effect. Close the app fully (end any leftover node.exe in Task Manager) or restart Windows, then open the app again.";
                append_log(&api_log, message);
                report_startup_failure(
                    &api_log,
                    "برای فعال شدن حالت «سرور شبکه»، یک نمونهٔ قدیمی برنامهٔ تک‌کامپیوتری هنوز در پس‌زمینه فعال است.\n\nبرنامه را کاملاً ببندید و در Task Manager هر پروسهٔ node.exe باقی‌مانده را پایان دهید (یا ویندوز را ری‌استارت کنید)، سپس برنامه را دوباره باز کنید.",
                );
                return;
            }
        }
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
    append_log(&api_log, &format!("Bundled API is ready on {api_host}:4317."));
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

/// Minimal standard-library base64 (standard alphabet, padded) — used to
/// move payloads through PowerShell's -EncodedCommand without depending on
/// an external crate.
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[triple as usize & 63] as char } else { '=' });
    }
    out
}

/// Decodes standard base64 (padding optional) for file payloads.
fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut reverse = [255u8; 128];
    for (index, symbol) in TABLE.iter().enumerate() {
        reverse[*symbol as usize] = index as u8;
    }
    let mut out = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes().filter(|b| !b" \t\r\n".contains(b)) {
        if byte == b'=' {
            break;
        }
        let value = *reverse.get(byte as usize).unwrap_or(&255);
        if value == 255 {
            return Err(format!("invalid base64 byte {byte}"));
        }
        accumulator = (accumulator << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    Ok(out)
}

fn utf16le(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect()
}

/// Prints plain text straight to the Windows print spooler through
/// PowerShell's `Out-Printer` — no print dialog. An empty `printer` targets
/// the system default printer. The text travels inside an -EncodedCommand
/// payload (base64 of UTF-16LE) so Dari/Pashto survives any console code
/// page; the frontend falls back to the normal print dialog on any error.
#[cfg(windows)]
fn quick_print_impl(printer: &str, text: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let name = printer.trim();
    let printer_part = if name.is_empty() {
        String::new()
    } else {
        format!(" -Name '{}'", name.replace('\'', "''"))
    };
    let script = format!(
        "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')); $t | Out-Printer{}",
        base64_encode(text.as_bytes()),
        printer_part
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &base64_encode(&utf16le(&script))])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("print failed: {}", stderr))
    }
}

#[cfg(not(windows))]
fn quick_print_impl(printer: &str, text: &str) -> Result<(), String> {
    let _ = (printer, text);
    Err("quick print is only available on Windows".into())
}

#[tauri::command]
fn quick_print(printer: String, text: String) -> Result<(), String> {
    quick_print_impl(&printer, &text)
}

/// Writes a portable database backup (base64 payload from the API) into the
/// user's Documents\DarPOS-Backups folder and returns the full path, so it
/// can be copied to a USB stick or another machine.
#[tauri::command]
fn save_backup_file(filename: String, data_base64: String) -> Result<String, String> {
    let safe = sanitize_file_name(&filename)?;
    let documents = std::env::var_os("USERPROFILE")
        .map(|home| std::path::PathBuf::from(home).join("Documents"))
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join("Documents")))
        .ok_or("could not resolve the Documents folder")?;
    let dir = documents.join("DarPOS-Backups");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let bytes = base64_decode(&data_base64)?;
    if bytes.len() < 100 {
        return Err("backup payload looks empty".into());
    }
    let target = dir.join(safe);
    std::fs::write(&target, bytes).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Keeps a caller-supplied file name safe for the file system: ASCII letters,
/// digits and the separators we generate ourselves; anything else is dropped.
fn sanitize_file_name(filename: &str) -> Result<String, String> {
    let safe: String = filename
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("invalid file name".into());
    }
    Ok(safe)
}

/// Saves an exported report (CSV text or the product-import template) into the
/// user's Downloads folder and returns the full path. The webview cannot run
/// browser-style downloads (the `download` attribute on a blob link is a
/// no-op in WebView2/wry), so file exports the user asks for go through this
/// command instead; a same-named file from an earlier export is overwritten.
#[tauri::command]
fn save_export_file(app: tauri::AppHandle, filename: String, data_base64: String) -> Result<String, String> {
    let safe = sanitize_file_name(&filename)?;
    let bytes = base64_decode(&data_base64)?;
    if bytes.is_empty() {
        return Err("nothing to save".into());
    }
    let dir = update_download_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let target = dir.join(safe);
    std::fs::write(&target, bytes).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// Where update installers are saved: the user's Downloads folder when it
/// exists (so the setup file stays available for a re-install), otherwise the
/// shared app-data directory.
fn update_download_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let downloads = std::path::PathBuf::from(home).join("Downloads");
        if downloads.is_dir() {
            return downloads;
        }
    }
    app_data_directory(app)
}

/// Downloads the given GitHub release asset (the NSIS setup .exe) into the
/// Downloads folder and returns the saved path. Uses PowerShell's
/// Invoke-WebRequest (always present on Windows 10/11, follows the release
/// redirect) so no new Rust dependency is needed; the URL and version are
/// validated before anything runs.
#[tauri::command]
fn download_update(app: tauri::AppHandle, url: String, version: String) -> Result<String, String> {
    if !url.starts_with("https://github.com/") {
        return Err("unsupported download url".into());
    }
    let safe_version: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect();
    if safe_version.is_empty() {
        return Err("invalid version".into());
    }
    let dir = update_download_dir(&app);
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return Err(error.to_string());
    }
    let target = dir.join(format!("DarPOS-Setup-{safe_version}.exe"));
    // Args are passed as separate process arguments (no shell string), so the
    // URL and path cannot inject commands.
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Invoke-WebRequest",
            // Windows PowerShell 5.1 parses responses with the IE engine by
            // default, which hangs on machines without a configured IE;
            // -UseBasicParsing avoids that (a no-op on PowerShell 7+).
            "-UseBasicParsing",
            "-Uri",
            url.as_str(),
            "-OutFile",
        ])
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&target);
        return Err("download failed".into());
    }
    // A real installer is several MB; anything smaller is an error page that
    // was saved as .exe.
    let size = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
    if size < 1_000_000 {
        let _ = std::fs::remove_file(&target);
        return Err("downloaded file is not the installer".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Launches a downloaded installer, stops the bundled API, and exits the app
/// so setup can replace the running files. Only files inside our own update
/// folder are accepted — the frontend can never run arbitrary paths.
#[tauri::command]
fn install_update(app: tauri::AppHandle, state: tauri::State<ApiProcess>, path: String) -> Result<(), String> {
    let resolved = match std::fs::canonicalize(&path) {
        Ok(path) => path,
        Err(error) => return Err(error.to_string()),
    };
    let folder = match std::fs::canonicalize(update_download_dir(&app)) {
        Ok(path) => path,
        Err(error) => return Err(error.to_string()),
    };
    if !resolved.starts_with(&folder) || !resolved.extension().map(|ext| std::ffi::OsStr::eq_ignore_ascii_case(ext, "exe")).unwrap_or(false) {
        return Err("installer is not in the update folder".into());
    }
    // Spawn first: if the installer cannot start we keep running untouched.
    Command::new(&resolved)
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    // Same cleanup as closing the window, so the new version starts its own
    // API instead of reusing this one.
    stop_api(&state);
    std::process::exit(0)
}

fn main() {
    let child_state = ApiProcess(Arc::new(Mutex::new(None)));
    let state_for_exit = child_state.clone();
    let closing = Arc::new(AtomicBool::new(false));
    let closing_for_setup = closing.clone();
    let closing_for_exit = closing.clone();
    tauri::Builder::default()
        .manage(child_state)
        .invoke_handler(tauri::generate_handler![set_network_mode, get_network_mode, open_url, quick_print, save_backup_file, save_export_file, download_update, install_update])
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

/// Reads the persisted LAN mode so the Settings page can restore the saved
/// selection ("" when nothing was saved yet). Without this the dropdown
/// always fell back to «تک‌کامپیوتر» after an app restart.
#[tauri::command]
fn get_network_mode(app: tauri::AppHandle) -> Result<String, String> {
    match std::fs::read_to_string(app_data_directory(&app).join("network-mode")) {
        Ok(content) => Ok(content.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
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
