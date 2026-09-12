import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    "@denicheur-breizh/collector-contracts": fileURLToPath(new URL("../../packages/collector-contracts/src/index.ts", import.meta.url)),
    "@denicheur-breizh/i18n": fileURLToPath(new URL("../../packages/i18n/src/index.ts", import.meta.url)),
  } },
  server: {
    host: "127.0.0.1", port: 5175, strictPort: true,
    proxy: { "/api": { target: process.env.COLLECTOR_API_UPSTREAM ?? "http://127.0.0.1:4315", changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, "") } },
  },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts", restoreMocks: true },
});
