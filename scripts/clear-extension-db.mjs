#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const EXTENSION_ID = "oekklajlieiinmjcmhdfeodpdhahhjdi";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const CALLBACK_PATH = "/extension-db-cleaned";
const CALLBACK_TIMEOUT_MS = 20_000;
const CLEAR_ALL = process.argv.includes("--all");

const REPEATABLE_FILTERS = [
  "Transaction: Vente",
  "Location: Finistère",
  "Type: Maison",
  "Prix min: vide",
  "Prix max: 120000",
  "Pièces min/max: 2 / 3",
  "Chambres et surface: vides",
  "Vendeur: Tous",
  "Tri: Recent",
  "Max listings: 1",
  "Collect detail pages: activé",
  "Delay min/max: 25 / 55 s",
  "Pause every / cooldown: 5 / 180 s",
  "Intelligence filter: désactivé",
];

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm db:clean
       pnpm db:clean:extension

db:clean clears extension iteration data, pending synchronization state, and
the API SQLite rendered by the web app. db:clean:extension clears only stored
extension listings and the last run. Both preserve filters, recipes, locale,
and theme. Google Chrome must have the current unpacked Denicheur Breizh build
loaded.`);
  process.exit(0);
}

const token = randomBytes(24).toString("hex");
const acknowledgement = Promise.withResolvers();
const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", EXTENSION_ORIGIN);
  response.setHeader("Cache-Control", "no-store");

  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const hasValidOrigin = request.headers.origin === EXTENSION_ORIGIN;
  const hasValidToken = requestUrl.searchParams.get("token") === token;

  if (
    request.method !== "POST" ||
    requestUrl.pathname !== CALLBACK_PATH ||
    !hasValidOrigin ||
    !hasValidToken
  ) {
    response.statusCode = 403;
    response.end();
    return;
  }

  response.statusCode = 204;
  response.end();
  acknowledgement.resolve({
    status: requestUrl.searchParams.get("status"),
    reason: requestUrl.searchParams.get("reason"),
  });
});

try {
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate the local confirmation port.");
  }

  const callbackUrl = new URL(`http://127.0.0.1:${address.port}${CALLBACK_PATH}`);
  callbackUrl.searchParams.set("token", token);
  const deadlineAt = Date.now() + CALLBACK_TIMEOUT_MS;

  const dashboardUrl = new URL(`${EXTENSION_ORIGIN}/dashboard.html`);
  dashboardUrl.searchParams.set("action", CLEAR_ALL ? "clean-all-data" : "clean-db");
  dashboardUrl.searchParams.set("callback", callbackUrl.toString());
  dashboardUrl.searchParams.set("deadline", String(deadlineAt));

  openChrome(dashboardUrl.toString());
  const result = await Promise.race([
    acknowledgement.promise,
    rejectAt(deadlineAt),
  ]);

  if (result.status === "busy") {
    throw new Error("La extensión tiene una colecta activa. Cancelala o esperá a que termine y volvé a correr el comando.");
  }
  if (result.status !== "ok") {
    throw new Error(`La extensión no pudo limpiar sus datos (${result.reason ?? "error desconocido"}).`);
  }

  console.log(CLEAR_ALL
    ? "Datos de iteración limpios: 0 anuncios en la extensión y en el API; corrida reiniciada."
    : "Base local de la extensión limpia: 0 anuncios y corrida reiniciada.");
  console.log("Filtros, receta, idioma y tema fueron conservados.\n");
  console.log("Perfil de prueba repetible:");
  for (const filter of REPEATABLE_FILTERS) console.log(`  - ${filter}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(CLEAR_ALL
    ? "Verificá que el API local esté activo y que Chrome tenga cargada y recargada la build unpacked actual de Denicheur Breizh."
    : "Verificá que Chrome tenga cargada y recargada la build unpacked actual de Denicheur Breizh.");
  process.exitCode = 1;
} finally {
  await close(server);
}

function listen(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
}

function close(httpServer) {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
}

function rejectAt(deadlineAt) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(
      `Chrome no confirmó la limpieza dentro de ${CALLBACK_TIMEOUT_MS / 1_000} segundos.`,
    )), Math.max(0, deadlineAt - Date.now())).unref();
  });
}

function openChrome(url) {
  const customBrowser = process.env.DENICHEUR_BROWSER_BIN?.trim();
  let command;
  let args;

  if (customBrowser) {
    command = customBrowser;
    args = [url];
  } else if (process.platform === "darwin") {
    command = "/usr/bin/open";
    args = ["-a", process.env.DENICHEUR_CHROME_APP?.trim() || "Google Chrome", url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const opened = spawnSync(command, args, { stdio: "ignore" });
  if (opened.error) throw opened.error;
  if (opened.status !== 0) {
    throw new Error(`No se pudo abrir Google Chrome (exit ${opened.status ?? "unknown"}).`);
  }
}
