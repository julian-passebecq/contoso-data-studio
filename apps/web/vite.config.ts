import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// Serves the vendored standalone concept viewer (repo vendor/concept-viewer/, never patched) at
// /vendor/concept-viewer/*. Missing files are a 404 so the Architecture tab falls back to the SVG.
// `vite build` copies the same files into dist/vendor/concept-viewer/.
const viewerDir = fileURLToPath(new URL("../../vendor/concept-viewer/", import.meta.url));
function conceptViewer(): Plugin {
  return {
    name: "contoso-concept-viewer",
    configureServer(server) {
      server.middlewares.use("/vendor/concept-viewer/", (req, res) => {
        const name = (req.url ?? "").split(/[?#]/)[0].replace(/^\/+/, "");
        const file = viewerDir + name;
        if (!/^[A-Za-z0-9._-]+\.html$/.test(name) || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("X-Concept-Viewer", "vendored");
        if (req.method === "HEAD") { res.end(); return; }
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      if (!existsSync(viewerDir)) return;
      for (const name of readdirSync(viewerDir).filter(n => n.endsWith(".html")).sort()) {
        this.emitFile({ type: "asset", fileName: `vendor/concept-viewer/${name}`, source: readFileSync(viewerDir + name) });
      }
    },
  };
}

// CONTOSO_API_URL lets QA / tour tooling point the dev proxy at a non-default API port.
const apiTarget = process.env.CONTOSO_API_URL || "http://localhost:8000";

export default defineConfig({
  plugins: [react(), conceptViewer()],
  server: {
    port: 5173,
    proxy: { "/api": apiTarget }
  }
});
