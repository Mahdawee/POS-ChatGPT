import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyDocumentLanguage, LanguageProvider, lang } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./fonts.css";
import "./styles.css";

// Direction/language must match the stored choice before the first paint,
// otherwise an English user would see one RTL flash at startup.
applyDocumentLanguage(lang());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// PWA: در مرورگر معمولی (گوشی یا کامپیوتر دیگری که UI را از سرور باز کرده)
// سرویس‌ورکر ثبت می‌شود تا برنامه نصب‌شدنی و آفلاین‌بازشونده باشد. داخل
// برنامهٔ دسکتاپ Tauri نیازی به آن نیست و پشتیبانی هم نمی‌شود، پس ثبت نمی‌شود.
if (typeof window !== "undefined" && "serviceWorker" in navigator && !("__TAURI_INTERNALS__" in window)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("service worker registration failed", error);
    });
  });
}
