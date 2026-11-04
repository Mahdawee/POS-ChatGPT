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
