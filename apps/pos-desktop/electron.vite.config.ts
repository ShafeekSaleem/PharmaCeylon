import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// The shared package is published as CommonJS with `export *` re-exports, which Rollup cannot
// see through; bundle its TypeScript source instead so named runtime imports resolve.
const shared = { "@pharmaceylon/shared": resolve(__dirname, "../../packages/shared/src/index.ts") };

// Output goes to dist/ (not electron-vite's default out/) so the root turbo
// `build` task caches it with the same `dist/**` glob the other workspaces use.
export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      outDir: "dist/main",
      lib: { entry: resolve(__dirname, "src/main/index.ts"), formats: ["cjs"] },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      // A sandboxed preload can only require("electron"), so everything else
      // it imports (the IPC contract and its validators) is bundled in.
      externalizeDeps: false,
      lib: { entry: resolve(__dirname, "src/preload/index.ts"), formats: ["cjs"] },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, "dist/renderer"),
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
    server: {
      // The renderer imports the PMS design tokens straight from apps/web.
      fs: { allow: [resolve(__dirname, "../..")] },
    },
  },
});
