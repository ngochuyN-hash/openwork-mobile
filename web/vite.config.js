import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    target: "es2020",
  },
  server: {
    port: 5180,
    proxy: {
      "/api": "http://127.0.0.1:8788",
    },
  },
});
