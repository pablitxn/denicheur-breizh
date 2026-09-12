import {readFile, readdir, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(process.argv[2] ?? join(root, "apps/collector-api/.data/reports"));
const identity = value => {
  try {
    const url = new URL(value);
    if (!["leboncoin.fr", "www.leboncoin.fr"].includes(url.hostname)) return null;
    return /\/([0-9]+)(?:\.htm)?\/?$/u.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
};
const letter = value => typeof value === "string" && /^[A-G]$/iu.test(value.trim()) ? value.trim().toUpperCase() : null;
const rows = [];
for (const file of (await readdir(directory)).filter(name => /^capture-[\da-f-]+\.json$/u.test(name)).sort()) {
  const capture = JSON.parse(await readFile(join(directory, file), "utf8"));
  if (capture.run?.request?.provider !== "firecrawl") continue;
  for (const artifact of capture.artifacts ?? []) {
    if (artifact.kind !== "firecrawl_scrape" || artifact.runId !== capture.run.id || artifact.payload?.success !== true) continue;
    const data = artifact.payload.data;
    const id = identity(data?.metadata?.sourceURL);
    if (!id) continue;
    const observations = data?.json?.observations;
    const model = Array.isArray(observations) ? observations.filter(item => identity(item.url) === id) : [];
    if (model.length !== 1) continue;
    const scripts = (data.actions?.javascriptReturns ?? []).map(item => item.value).filter(item =>
      item && item.phase === "observe" && identity(item.url) === id && item.blocked === false &&
      /^leboncoin-(?:detail-repair-v4|native-inventory-v5|gallery-audit-v6|gallery-walk-v7)$/u.test(item.preparation));
    for (const [field, key] of [["energyClass", "energy_rate"], ["gesClass", "ges"]]) {
      const dom = new Set(), native = new Set();
      for (const script of scripts) {
        const selected = script.fields?.[field];
        if (selected?.selected === true && typeof selected.selector === "string" && selected.selector.trim() && letter(selected.value)) dom.add(letter(selected.value));
        const sources = [...(script.structuredData ?? []), ...(script.inventory ? [script.inventory] : [])];
        for (const source of sources) if (String(source.listingId) === id) for (const attribute of source.attributes ?? []) {
          if (attribute.key === key && letter(attribute.value)) native.add(letter(attribute.value));
        }
      }
      const modelValue = letter(model[0].data?.[field]);
      const confirmed = dom.size === 1 && native.size === 1 && [...dom][0] === [...native][0];
      if (modelValue && confirmed && modelValue !== [...native][0]) rows.push({runId:capture.run.id, strategy:capture.run.strategy,
        listingId:`leboncoin:${id}`, field, modelValue, nativeValue:[...native][0], domValue:[...dom][0], at:artifact.at, artifactId:artifact.id});
    }
  }
}
const byRun = Object.fromEntries([...new Set(rows.map(row => row.runId))].map(runId => {
  const records = rows.filter(row => row.runId === runId);
  return [runId, {discrepancies:records.length, listings:new Set(records.map(row => row.listingId)).size}];
}));
const report = {generatedAt:new Date().toISOString(), method:"Same response only: model letter disagrees with matching native attribute and selected DOM letter, which agree with each other. Exemptions, missing values and ambiguous evidence require separate review and are excluded, never counted as accurate.", byRun, discrepancies:rows};
await writeFile(join(directory, "native-evidence-audit.json"), JSON.stringify(report,null,2)+"\n", {mode:0o600});
await writeFile(join(directory, "native-evidence-audit.md"), ["# Contraste de diagnósticos dentro de la misma respuesta", "", report.method, "",
  "Los recuentos son por respuesta. Una identidad puede aparecer en varias ejecuciones; no se deben sumar como anuncios distintos. No es una evaluación de cobertura ni una comparación temporal.", "",
  "| Ejecución | Desacuerdos | Anuncios |", "|---|---:|---:|",
  ...Object.entries(byRun).map(([id, value]) => `| [${id}](capture-${id}.json) | ${value.discrepancies} | ${value.listings} |`), "",
  "El JSON adjunto conserva los valores, timestamps e identificadores de los artefactos para reproducir cada contraste.", ""].join("\n"), {mode:0o600});
console.log(JSON.stringify({report:join(directory,"native-evidence-audit.json"), byRun}));
