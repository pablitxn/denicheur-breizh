import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

test("offline audit counts supported same-response errors and excludes ambiguous or foreign evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-native-audit-"));
  try {
    const runId = "11111111-1111-4111-8111-111111111111";
    const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/1234567";
    const artifact = (id, model, dom, native, options = {}) => ({id, runId, kind:"firecrawl_scrape", at:"2026-09-12T12:00:00Z", payload:{success:true, data:{metadata:{sourceURL:url}, json:{observations:[{url, data:{gesClass:model}}]}, actions:{javascriptReturns:[{value:{preparation:"leboncoin-gallery-walk-v7", phase:"observe", url, blocked:false,
      fields:{gesClass:{selected:options.selected ?? true, selector:"[data-qa-id=criteria_item_ges]", value:dom}},
      structuredData:[{listingId:options.id ?? "1234567", attributes:[{key:"ges", value:native}]}]}}]}}}});
    writeFileSync(join(dir,`capture-${runId}.json`), JSON.stringify({run:{id:runId, strategy:"firecrawl-gallery-walk-v7", request:{provider:"firecrawl"}}, artifacts:[
      artifact("wrong-letter", "G", "C", "c"), artifact("wrong-exemption", "non soumis", "A", "a"),
      artifact("match", "C", "C", "c"), artifact("uncertain-source", "G", "A", "c"),
      artifact("legend-only", "G", "C", "c", {selected:false}), artifact("foreign", "G", "C", "c", {id:"9999999"}),
      artifact("unknown-model", "inconnu", "C", "c"),
    ]}));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./collector-native-audit.mjs", import.meta.url)), dir], {encoding:"utf8"});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(dir,"native-evidence-audit.json"),"utf8"));
    assert.deepEqual(report.discrepancies.map(row => row.artifactId), ["wrong-letter"]);
    assert.deepEqual(report.byRun[runId], {discrepancies:1,listings:1});
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
