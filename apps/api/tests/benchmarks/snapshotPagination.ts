// Synthetic private temporary databases only. No providers or user database access.
// node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/snapshotPagination.ts
// Optional BENCH_BASELINE_MODULE is a local module exporting an earlier DenicheurRepository.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { DenicheurRepository } from "../../src/repository.js";

const baselineModule = process.env.BENCH_BASELINE_MODULE;
const repositories = [{ name: "current", Repository: DenicheurRepository }];
if (baselineModule) repositories.unshift({ name: "baseline", Repository: (await import(baselineModule)).DenicheurRepository });
const now = "2026-09-06T10:00:00.000Z";
for (const { name, Repository } of repositories) {
  for (const count of [100, 1000, 5000]) {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-pagination-bench-"));
    const path = join(directory, "synthetic.sqlite");
    const repository = new Repository({ path, now: () => new Date(now) });
    const database = new DatabaseSync(path);
    try {
      repository.saveRecipe("benchmark", { name: "Synthetic", threshold: 50, criteria: [{ id: "garden", name: "Garden", description: "Has garden", weight: 1, required: false }] });
      database.exec("BEGIN");
      database.prepare("INSERT INTO runs(id,source,status,updated_at,data_json) VALUES ('benchmark','leboncoin','completed',?,?)")
        .run(now, JSON.stringify({ id: "benchmark", source: "leboncoin", status: "completed" }));
      const insertListing = database.prepare(`INSERT INTO listings(source,external_id,url,status,scraped_at,first_seen_at,last_seen_at,updated_at,last_run_id,price_euros,surface_m2,data_json)
        VALUES ('leboncoin',?,?,'detailed',?,?,?,?,'benchmark',250000,85,?)`);
      const insertSnapshot = database.prepare(`INSERT INTO run_listings(run_id,source,external_id,first_observed_at,observed_at,status,scraped_at,observation_json)
        SELECT 'benchmark',source,external_id,first_seen_at,last_seen_at,status,scraped_at,data_json FROM listings WHERE external_id = ?`);
      const insertMedia = database.prepare("INSERT OR IGNORE INTO media_assets(id,source_url,status,storage_generation,created_at,updated_at) VALUES (?,?,'pending','synthetic',?,?)");
      const linkMedia = database.prepare("INSERT INTO listing_media(source,external_id,position,asset_id) VALUES ('leboncoin',?,?,?)");
      const insertEvaluation = database.prepare(`INSERT INTO evaluations(run_id,source,external_id,recipe_id,recipe_version,locale,evaluated_at,decision,score,evaluator_json,result_json)
        VALUES ('benchmark','leboncoin',?,'benchmark',1,'fr',?,'relevant',90,?,?)`);
      for (let index = 0; index < count; index += 1) {
        const id = String(index).padStart(6, "0");
        const url = `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`;
        const imageUrls = ["https://img.leboncoin.fr/shared.jpg", `https://img.leboncoin.fr/${id}.jpg`];
        insertListing.run(id, url, now, now, now, now, JSON.stringify({
          source: "leboncoin", externalId: id, url, status: "detailed", scrapedAt: now,
          title: `Synthetic property ${id}`, priceEuros: 250_000, surfaceM2: 85, propertyType: "Maison",
          description: "Synthetic property text. ".repeat(80), features: ["Garden", "Garage"], imageUrls,
        }));
        insertSnapshot.run(id);
        imageUrls.forEach((sourceUrl, position) => {
          const assetId = createHash("sha256").update(sourceUrl).digest("hex");
          insertMedia.run(assetId, sourceUrl, now, now);
          linkMedia.run(id, position, assetId);
        });
        insertEvaluation.run(id, now, JSON.stringify({ provider: "openai", model: "synthetic", version: "1.0.0" }), JSON.stringify({
          listingId: `leboncoin:${id}`, decision: "relevant", score: 90, summary: "Synthetic result",
          criteria: [{ criterionId: "garden", verdict: "pass", reason: "Synthetic", evidence: ["Garden"] }], missingData: [], evaluatedAt: now,
        }));
      }
      database.exec("COMMIT");
      const measure = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
      const pageQuery = { limit: 50, sort: "updatedAt", order: "desc" } as const;
      const firstPageMs = measure(() => repository.listListings(pageQuery));
      const coldMs: number[] = [];
      for (let iteration = 0; iteration < 5; iteration += 1) {
        // A synthetic capture batch changes twenty listings between first-page polls.
        database.prepare("UPDATE listings SET updated_at = ? WHERE external_id < '000020'").run(`2026-09-06T10:00:0${iteration + 1}.000Z`);
        coldMs.push(measure(() => repository.listListings(pageQuery)));
      }
      for (let iteration = 0; iteration < 20; iteration += 1) repository.listListings(pageQuery);
      const warmMs = Array.from({ length: 100 }, () => measure(() => repository.listListings(pageQuery))).sort((a, b) => a - b);
      coldMs.sort((a, b) => a - b);
      const snapshots = name === "current" ? database.prepare("SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes FROM pagination_snapshots").get() : undefined;
      const firstMapMs = name === "current" ? measure(() => repository.listMapListings({ limit: 500 })) : undefined;
      const mapEtag = name === "current" ? repository.listMapListings({ limit: 500 }).etag : undefined;
      const unchangedMapMs = mapEtag ? measure(() => repository.listMapListings({ limit: 500 }, mapEtag)) : undefined;
      let newRevisionMapMs: number | undefined;
      if (name === "current") {
        database.prepare("UPDATE listings SET updated_at = ? WHERE external_id < '000020'").run("2026-09-06T10:01:00.000Z");
        newRevisionMapMs = measure(() => repository.listMapListings({ limit: 500 }, mapEtag));
      }
      const payloadCache = name === "current" ? database.prepare("SELECT COUNT(*) AS count, SUM(size_bytes) AS bytes FROM listing_projection_payloads").get() : undefined;
      process.stdout.write(JSON.stringify({ name, count, pageSize: 50, firstPageMs, coldMedianMs: coldMs[2], coldMaxMs: coldMs[4], warmMedianMs: warmMs[50], warmP95Ms: warmMs[95], snapshots, payloadCache, firstMapMs, unchangedMapMs, newRevisionMapMs, dbBytes: statSync(path).size, walBytes: statSync(`${path}-wal`).size }) + "\n");
    } finally { database.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); }
  }
}
