import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    rollupOptions: {
      output: {
        // Third-party code (react, react-dom, lucide icons, @tauri-apps/api)
        // goes into its own chunk: app updates then ship a tiny index.js and
        // registers reuse the cached vendor bundle instead of re-downloading
        // the whole library set with every release.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("lucide-react")) return "icons";
            return "vendor";
          }
        },
      },
    },
  },
});
