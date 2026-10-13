import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // Tauri copies `remote/` into src-tauri/target as a bundle resource; the copies' tests must not run a second time.
  test: { exclude: [...configDefaults.exclude, "src-tauri/**"] },

  // ELK is loaded lazily by the architecture panel; pre-bundling it avoids a dev reload on first use.
  optimizeDeps: { include: ["elkjs/lib/elk-api.js"] },

  build: {
    // The main window and the editor, diff, guardrails and settings windows (see ui/nativeWindow.ts) are separate pages.
    rollupOptions: { input: ["index.html", "editor.html", "diff.html", "guardrails.html", "settings.html"] },
    // Keep the ~2,500 Atom Material icon SVGs (src/diff/atomIcons) as separate asset files instead of inlining them
    assetsInlineLimit: (filePath: string) => (filePath.includes("atomIcons") ? false : undefined),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
