// ─────────────────────────────────────────────────────────────────────────────
// Service worker برنامهٔ «روشن» — فقط پوستهٔ وب (PWA shell) کش می‌شود.
//
// قواعد:
//   • هر درخواست /api همیشه مستقیم به سرور می‌رود — دادهٔ فروش/موجودی/گزارش
//     هرگز از کش داده نمی‌شود.
//   • بازکردن صفحه (navigate) اول از شبکه می‌آید؛ اگر شبکه نبود، پوستهٔ کش‌شده.
//   • فایل‌های استاتیک (JS/CSS/آیکون با نام هش‌دار) cache-first + نوسازی
//     پس‌زمینه‌ای.
//   • در برنامهٔ دسکتاپ Tauri این فایل اصلاً ثبت نمی‌شود (نگاه کنید به
//     desktop/src/main.tsx).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE = "darpos-shell-v1";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // دادهٔ زنده فقط

  // بازکردن صفحه: شبکه اول، پوستهٔ کش‌شده به‌عنوان جایگزین آفلاین.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // فایل‌های استاتیک: کش اول + نوسازی پس‌زمینه‌ای.
  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put(request, copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);
      return cached || refresh;
    }),
  );
});
