import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

const realtimeSessionPath = "/api/realtime/session";

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function realtimeSessionPlugin(apiKey?: string): Plugin {
  const middleware = async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    const requestPath = req.url ? new URL(req.url, "http://localhost").pathname : "";

    if (requestPath !== realtimeSessionPath) {
      next();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (!apiKey) {
      sendJson(res, 500, { error: "OPENAI_API_KEY is required on the server." });
      return;
    }

    try {
      const sdp = await readBody(req);
      const session = JSON.stringify({
        type: "realtime",
        model: "gpt-realtime-2",
        instructions:
          "You are a live Spanish-to-French interpreter. Translate every Spanish user utterance into natural French. Do not answer the request or add commentary; only provide the French translation.",
        audio: {
          output: {
            voice: "marin",
          },
        },
      });

      const formData = new FormData();
      formData.set("sdp", sdp);
      formData.set("session", session);

      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });

      const responseText = await response.text();
      res.statusCode = response.status;
      res.setHeader("Content-Type", response.headers.get("content-type") ?? "application/sdp");
      res.end(responseText);
    } catch (error) {
      next(error);
    }
  };

  return {
    name: "openai-realtime-session",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), realtimeSessionPlugin(env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY)],
    resolve: {
      alias: {
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
