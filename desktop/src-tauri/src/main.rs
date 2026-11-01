#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Manager;

#[derive(Clone)]
struct ApiProcess(Arc<Mutex<Option<Child>>>);

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

fn main() {
    let child_state = ApiProcess(Arc::new(Mutex::new(None)));
    let state_for_exit = child_state.clone();
    tauri::Builder::default()
        .manage(child_state)
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let roaming = std::env::var_os("APPDATA")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?);
                let data_dir = roaming.join("DarPOSERP");
                std::fs::create_dir_all(&data_dir)?;
                let api_log = data_dir.join("api.log");
                append_log(&api_log, "Starting the bundled local POS API.");

                let runtime = match app.path().resolve("runtime", tauri::path::BaseDirectory::Resource) {
                    Ok(path) => path,
                    Err(error) => {
                        append_log(&api_log, &format!("Could not resolve bundled runtime: {error}"));
                        return Err(error.into());
                    }
                };
                let node = runtime.join("node.exe");
                let server_dir = runtime.join("server");
                let entry = server_dir.join("dist").join("main.js");
                if !node.is_file() || !entry.is_file() {
                    let message = format!(
                        "Bundled API files are missing. node={}, entry={}",
                        node.display(),
                        entry.display()
                    );
                    append_log(&api_log, &message);
                    return Err(std::io::Error::new(std::io::ErrorKind::NotFound, message).into());
                }

                let stdout = OpenOptions::new().create(true).append(true).open(&api_log)?;
                let stderr = stdout.try_clone()?;
                let mut child = match Command::new(&node)
                    .arg(&entry)
                    .env("POS_DATA_DIR", &data_dir)
                    .env("API_HOST", "127.0.0.1")
                    .env("API_PORT", "4317")
                    .current_dir(&server_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(stdout))
                    .stderr(Stdio::from(stderr))
                    .spawn()
                {
                    Ok(child) => child,
                    Err(error) => {
                        append_log(&api_log, &format!("Could not start bundled Node.js: {error}"));
                        return Err(error.into());
                    }
                };

                let mut ready = false;
                for _ in 0..160 {
                    if TcpStream::connect("127.0.0.1:4317").is_ok() {
                        ready = true;
                        break;
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            append_log(&api_log, &format!("Bundled API exited before startup: {status}"));
                            let details = std::fs::read_to_string(&api_log).unwrap_or_default();
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::Other,
                                format!("The local POS API exited during startup. See {}.\n{details}", api_log.display()),
                            )
                            .into());
                        }
                        Ok(None) => {}
                        Err(error) => {
                            append_log(&api_log, &format!("Could not check bundled API process: {error}"));
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(error.into());
                        }
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                if !ready {
                    let _ = child.kill();
                    let _ = child.wait();
                    append_log(&api_log, "Bundled API did not listen on 127.0.0.1:4317 within 40 seconds.");
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("The local POS API did not start within 40 seconds. See {}.", api_log.display()),
                    )
                    .into());
                }
                append_log(&api_log, "Bundled API is ready on 127.0.0.1:4317.");
                match app.state::<ApiProcess>().0.lock() {
                    Ok(mut state) => *state = Some(child),
                    Err(_) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        append_log(&api_log, "Could not retain the bundled API process handle.");
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            format!("Could not manage the local POS API. See {}.", api_log.display()),
                        )
                        .into());
                    }
                }
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                stop_api(&state_for_exit);
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Dar POS");
}