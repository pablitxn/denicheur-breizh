import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig(() => {
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@denicheur-breizh/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
        "@denicheur-breizh/i18n": fileURLToPath(new URL("../../packages/i18n/src/index.ts", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
    build: {
      chunkSizeWarningLimit: 1100,
    },
    test: {
      environment: "jsdom",
      environmentOptions: {
        jsdom: {
          url: "http://localhost/",
        },
      },
      globals: true,
      setupFiles: "./src/test/setup.ts",
    },
  };
});
