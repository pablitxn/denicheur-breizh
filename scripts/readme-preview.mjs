#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = 14320;
const WEB_PORT = 14180;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const HELP = `Usage: node scripts/readme-preview.mjs --database /absolute/path/to/denicheur.sqlite

Run the real web app and API against a disposable SQLite snapshot for README captures.
Requires the repository's Node version and installed workspace dependencies (pnpm install).

  --database PATH  Required absolute path to an existing SQLite database.
  --help           Show this help without opening a database or starting servers.

The source database is opened read-only and copied with SQLite's online backup API,
including committed WAL contents. Only the private snapshot in the OS temporary
directory is writable. No database or source data is exported into the repository.
The snapshot retains its original data; review visible personal information before
publishing screenshots. Remote listing photos and map tiles may load in the browser.

Web: ${WEB_URL}
API: ${API_URL}

Both servers bind only to loopback and refuse occupied ports. No .env files or
credential environment variables are loaded. OpenAI, realtime voice, and media
mirroring are disabled. Press Ctrl+C to stop both servers and delete the snapshot.
`;

const shutdown = new AbortController();
const children = [];
let sessionDirectory;
let cleaningUp = false;

function log(message) {
  console.log(`[readme-preview] ${message}`);
}

function stop(reason) {
  if (!shutdown.signal.aborted) shutdown.abort(reason);
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(error.code === "EADDRINUSE"
      ? `Port ${port} is occupied (${error.code}). Stop its owner before starting this preview.`
      : `Cannot bind loopback port ${port} (${error.code ?? "unknown error"}): ${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close(resolvePromise));
  });
}

function launch(name, args, options) {
  shutdown.signal.throwIfAborted();
  const child = spawn(process.execPath, args, { stdio: "inherit", ...options });
  const closed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  children.push({ child, closed });
  child.once("error", (error) => stop(new Error(`${name} could not start: ${error.message}`)));
  child.once("exit", (code, signal) => {
    if (!cleaningUp) stop(new Error(`${name} stopped unexpectedly (${signal ?? code}).`));
  });
  return child;
}

async function waitFor(name, url, accept, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(1_000)]),
      });
      if (response.ok && await accept(response)) return;
    } catch {
      // The child may still be starting; its exit/error handler aborts this wait.
    }
    await delay(150, undefined, { signal: shutdown.signal });
  }
  throw new Error(`${name} did not become ready within ${timeoutMs / 1_000} seconds.`);
}

async function cleanup() {
  cleaningUp = true;
  await Promise.all(children.map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timeout.unref();
      await closed;
      clearTimeout(timeout);
    } else {
      await closed;
    }
  }));
  if (sessionDirectory) {
    // This path is exclusively the directory returned by our own mkdtemp call.
    await rm(sessionDirectory, { recursive: true, force: true });
    log("Servers stopped; temporary snapshot removed.");
  }
}

async function main() {
  const { values } = parseArgs({
    options: { database: { type: "string" }, help: { type: "boolean" } },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.database || !isAbsolute(values.database)) {
    throw new Error("Supply --database with an absolute path to an existing SQLite database. Use --help for details.");
  }
  if (!(await stat(values.database)).isFile()) throw new Error("--database must name a regular file.");

  const apiDirectory = join(ROOT, "apps/api");
  const webDirectory = join(ROOT, "apps/web");
  const apiRequire = createRequire(join(apiDirectory, "package.json"));
  const webRequire = createRequire(join(webDirectory, "package.json"));
  const tsxUrl = pathToFileURL(apiRequire.resolve("tsx")).href;
  const viteUrl = pathToFileURL(webRequire.resolve("vite")).href;
  await Promise.all([assertPortAvailable(API_PORT), assertPortAvailable(WEB_PORT)]);
  shutdown.signal.throwIfAborted();

  sessionDirectory = await mkdtemp(join(tmpdir(), "denicheur-readme-"));
  await chmod(sessionDirectory, 0o700);
  const snapshotPath = join(sessionDirectory, "preview.sqlite");
  const { DatabaseSync, backup } = await import("node:sqlite");
  const source = new DatabaseSync(values.database, { readOnly: true, timeout: 5_000 });
  try {
    await backup(source, snapshotPath);
  } finally {
    source.close();
  }
  await chmod(snapshotPath, 0o600);
  shutdown.signal.throwIfAborted();

  // Deliberately exclude NODE_OPTIONS, VITE_*, OPENAI_*, operator credentials,
  // and all storage credentials inherited from the invoking shell.
  const environment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  launch("API", ["--import", tsxUrl, "src/server.ts"], {
    cwd: apiDirectory,
    env: {
      ...environment,
      NODE_ENV: "development",
      FILTER_API_HOST: "127.0.0.1",
      FILTER_API_PORT: String(API_PORT),
      FILTER_API_ALLOWED_ORIGINS: WEB_URL,
      DENICHEUR_DB_PATH: snapshotPath,
      OPENAI_REALTIME_ENABLED: "false",
      MEDIA_STORAGE_MODE: "disabled",
    },
  });
  await waitFor("API", `${API_URL}/v1/health/details`, async (response) => {
    const health = await response.json();
    return health.service === "denicheur-api"
      && health.database?.status === "ok"
      && health.openAiConfigured === false
      && health.media?.status === "disabled";
  });

  // Build the actual production UI without .env loading or development controls.
  // Both the build output and Vite cache stay inside this disposable directory.
  const webLauncher = `
    import { build, preview } from ${JSON.stringify(viteUrl)};
    const config = {
      root: ${JSON.stringify(webDirectory)},
      configFile: ${JSON.stringify(join(webDirectory, "vite.config.ts"))},
      mode: "production",
      envDir: false,
      cacheDir: ${JSON.stringify(join(sessionDirectory, "vite-cache"))},
      build: { outDir: ${JSON.stringify(join(sessionDirectory, "web-dist"))}, emptyOutDir: true },
      preview: { host: "127.0.0.1", port: ${WEB_PORT}, strictPort: true, open: false }
    };
    let server;
    const close = async () => { await server?.close(); process.exit(0); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await build(config);
    server = await preview(config);
  `;
  log("Building the production web UI for capture…");
  launch("Web", ["--input-type=module", "--eval", webLauncher], {
    cwd: webDirectory,
    env: {
      ...environment,
      NODE_ENV: "production",
      VITE_API_BASE_URL: API_URL,
      VITE_ENABLE_REALTIME: "false",
    },
  });
  await waitFor("Web", WEB_URL, async (response) => (await response.text()).includes('<div id="root">'), 60_000);
  log(`Ready: ${WEB_URL}`);
  log(`API: ${API_URL} (OpenAI, realtime, and media mirroring disabled).`);
  log("Using a disposable snapshot. Review personal information before publishing captures.");
  log("Press Ctrl+C to stop and remove temporary data.");
  if (!shutdown.signal.aborted) {
    await new Promise((resolvePromise) => shutdown.signal.addEventListener("abort", resolvePromise, { once: true }));
  }
  shutdown.signal.throwIfAborted();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await main();
} catch (error) {
  const reason = shutdown.signal.aborted ? shutdown.signal.reason : error;
  if (reason !== "SIGINT" && reason !== "SIGTERM") {
    console.error(`[readme-preview] ${reason instanceof Error ? reason.message : String(reason)}`);
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
