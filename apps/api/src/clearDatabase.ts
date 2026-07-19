import { loadConfig } from "./config.js";
import { z } from "zod";

const responseSchema = z.object({
  deleted: z.object({
    listings: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    runListings: z.number().int().nonnegative(),
    evaluations: z.number().int().nonnegative(),
  }).strict(),
}).strict();

async function main(): Promise<void> {
  const config = loadConfig();
  const endpoint = `http://${config.host}:${config.port}/v1/maintenance/collected-data/clear`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ confirm: "clear-collected-data" }),
    });
  } catch (error) {
    throw new Error(
      `No se pudo conectar con el API local en ${endpoint}. Iniciá el API y volvé a intentar.`,
      { cause: error },
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "object" && payload.error !== null
      ? payload.error as Record<string, unknown>
      : undefined;
    const message = typeof apiError?.message === "string"
      ? apiError.message
      : `El API rechazó la limpieza (HTTP ${response.status}).`;
    throw new Error(message);
  }

  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("El API devolvió una respuesta de limpieza inválida.");
  const { deleted } = parsed.data;
  console.log(
    `SQLite del API limpia: ${deleted.listings} anuncios, ${deleted.runs} corridas, ` +
    `${deleted.runListings} observaciones y ${deleted.evaluations} evaluaciones eliminadas.`,
  );
  console.log("Versiones de recetas y migraciones fueron conservadas.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
