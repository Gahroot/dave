import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    // The API only trusts its own loopback origin. Present proxied dev requests as that
    // origin instead of localhost:5173, otherwise every write fails the same-origin guard.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:4317" },
      },
    },
  },
});
