fn main() {
    // «tauri dev» هم موقع کامپایل، وجود منبعٔ تعریف‌شدهٔ «resources/runtime»
    // را می‌سنجد؛ ولی runtime واقعی (node.exe + سرور کامپایل‌شده) فقط برای
    // بستهٔ نهایی با «npm run prepare:runtime» (بخشی از tauri:build) ساخته
    // می‌شود و در dev سرورِ API از «npm run dev:api» می‌آید. تا کلون تازه در
    // حالت توسعه هم کامپایل شود، در PROFILE=debug یک جای‌گذار خالی می‌سازیم.
    // بیلد release دست نمی‌زنیم تا بسته‌سازی بدون prepare:runtime همچنان
    // با پیام روشن شکست بخورد (تور ایمنی).
    let is_debug_build = std::env::var("PROFILE").map(|value| value == "debug").unwrap_or(false);
    if is_debug_build {
        let stub = std::path::Path::new("resources").join("runtime");
        if !stub.join("node.exe").is_file() {
            let _ = std::fs::create_dir_all(&stub);
            let _ = std::fs::write(
                stub.join(".dev-placeholder.txt"),
                "Placeholder for `tauri dev` — the real runtime is assembled by `npm run prepare:runtime` (part of `npm run tauri:build`).\n",
            );
        }
    }
    tauri_build::build()
}
