import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CONTOSO_API_URL lets QA / tour tooling point the dev proxy at a non-default API port.
const apiTarget = process.env.CONTOSO_API_URL || "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": apiTarget }
  }
});
